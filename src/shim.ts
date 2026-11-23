// Filters on an extension's MCP messages, as its host relays them. `switchboard` turns a
// Switchboard appendage (sbmcp: events with `_meta["switchboard/record"]`) into a Switch extension,
// so its tools carry over as they are; `readOnly` keeps only the tools that only look.
import { CONNECTIONS, VERSION } from "./app.ts"
import { MESSAGE_SCHEMA, SENDER_SCHEMA } from "./messages.ts"

export type Json = Record<string, unknown>

export interface Filter {
  /** A message on its way to the extension: forwarded (maybe changed), or answered here instead. */
  readonly inbound: (m: Json) => { readonly forward: Json | null; readonly answer: Json | null }
  /** A message from the extension: passed on (maybe changed), or dropped. */
  readonly outbound: (m: Json) => Json | null
}

export const isJson = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const field = (m: Json, key: string): Json => {
  const v = m[key]
  return isJson(v) ? v : {}
}

const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])

const pass = (m: Json) => ({ forward: m, answer: null })

/** Remembers the ids of requests by method, to know what a response answers. */
const asked = () => {
  const ids = new Map<unknown, string>()
  return {
    note: (m: Json) => {
      if (m.id !== undefined && typeof m.method === "string") {
        ids.set(m.id, m.method)
      }
    },
    /** The method a response answers, once; "" for anything else. */
    take: (m: Json) => {
      if (m.method !== undefined) {
        return ""
      }
      const method = ids.get(m.id) ?? ""
      ids.delete(m.id)
      return method
    },
  }
}

const RECORD = "switchboard/record"

/** What a shimmed event carries: its Switchboard record, envelope and body. */
const RECORD_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string" },
    stream: { type: "string" },
    data: {},
    about: { type: "array", items: { type: "string" } },
    refs: { type: "array", items: { type: "string" } },
    importance: { type: "number" },
    sender: SENDER_SCHEMA,
    message: MESSAGE_SCHEMA,
  },
  required: ["kind", "stream", "data"],
}

/** A channel's message (Claude Code's channels, `notifications/claude/channel`), as an event. */
const CHANNEL = "notifications/claude/channel"
const CHANNEL_EVENT = "message"

const ENVELOPE = ["about", "refs", "importance", "sender", "message"] as const

/**
 * A Switchboard appendage as an extension. Its event types gain the extension's prefix (`pr` becomes
 * `github-prs.pr`); each occurrence's payload is its record: `kind` and `stream` (where the type, or
 * the occurrence, says it lands; else `event` in `events/<extension>`), the record's `about`, `refs` and
 * `importance`, and its body as `data`. A fixed record id is the event id, so a resend is one event.
 */
export const switchboard = (extension: string): Filter => {
  const prefix = `${extension}.`
  const requests = asked()
  const placed = new Map<string, Json>()

  const renamed = (e: Json): Json => {
    const name = String(e.name)
    placed.set(name, field(field(e, "_meta"), RECORD))
    return {
      ...e,
      name: `${prefix}${name}`,
      delivery: ["push"],
      payloadSchema: RECORD_SCHEMA,
      _meta: { [VERSION]: 1 },
    }
  }

  const occurrence = (params: Json): Json => {
    const name = String(params.name)
    const where = placed.get(name) ?? {}
    const meta = field(params, "_meta")
    const envelope = field(meta, RECORD)
    const stream = [envelope.stream, where.stream].find((x) => typeof x === "string")
    const payload: Json = {
      kind: typeof where.kind === "string" ? where.kind : "event",
      stream: typeof stream === "string" ? stream : `events/${extension}`,
      data: params.data ?? null,
    }
    for (const key of ENVELOPE) {
      if (envelope[key] !== undefined) {
        payload[key] = envelope[key]
      }
    }
    const { [RECORD]: _, ...rest } = meta
    return {
      ...params,
      name: `${prefix}${name}`,
      eventId: typeof envelope.id === "string" ? envelope.id : params.eventId,
      data: payload,
      _meta: rest,
    }
  }

  /**
   * A channel's message: one of the user's own front doors (a bot only they can message), so its
   * sender is them. Its meta's `chat_id`, `message_id`, `user` and `ts` are the channel plugins'.
   */
  const fromChannel = (m: Json) => {
    const params = field(m, "params")
    const meta = field(params, "meta")
    const text = (k: string) => (typeof meta[k] === "string" ? meta[k] : "")
    const id =
      text("message_id") === "" ? crypto.randomUUID() : `${text("chat_id")}:${text("message_id")}`
    const ts = text("ts") === "" ? new Date().toISOString() : text("ts")
    const content = typeof params.content === "string" ? params.content : ""
    return occurrence({
      name: CHANNEL_EVENT,
      eventId: id,
      timestamp: ts,
      // Its place in the extension's own outbox, if it keeps one: acknowledged once the brain has it.
      cursor: typeof params.cursor === "string" ? params.cursor : null,
      data: { content, meta },
      _meta: {
        [RECORD]: {
          sender: { handle: text("user") || text("user_id"), via: extension, me: true },
          message: {
            id: `${extension}:${id}`,
            conversation: `${extension}:${text("chat_id")}`,
            text: content,
            at: Date.parse(ts),
            channel: extension,
          },
        },
      },
    })
  }

  // A channel server has no events of its own: its messages become one.
  let channel = false
  const channelEvent = (): Json => {
    placed.set(CHANNEL_EVENT, { kind: "message", stream: `comms/${extension}` })
    return {
      name: `${prefix}${CHANNEL_EVENT}`,
      delivery: ["push"],
      payloadSchema: RECORD_SCHEMA,
      _meta: { [VERSION]: 1 },
    }
  }

  return {
    inbound: (m) => {
      requests.note(m)
      const params = field(m, "params")
      const { name } = params
      if (channel && m.method === "events/stream" && name === `${prefix}${CHANNEL_EVENT}`) {
        return { forward: null, answer: { jsonrpc: "2.0", id: m.id, result: {} } }
      }
      if (
        (m.method === "events/stream" || m.method === "events/poll") &&
        typeof name === "string" &&
        name.startsWith(prefix)
      ) {
        return pass({ ...m, params: { ...params, name: name.slice(prefix.length) } })
      }
      return pass(m)
    },
    outbound: (m) => {
      const answers = requests.take(m)
      if ((answers === "initialize" || answers === "server/discover") && isJson(m.result)) {
        const experimental = field(field(m.result, "capabilities"), "experimental")
        channel = isJson(experimental["claude/channel"])
        return m
      }
      if (answers === "events/list") {
        const listed = isJson(m.result) ? list(m.result.events).filter(isJson).map(renamed) : []
        if (!channel && !isJson(m.result)) {
          return m
        }
        const events = channel ? [...listed, channelEvent()] : listed
        return { jsonrpc: "2.0", id: m.id, result: { ...field(m, "result"), events } }
      }
      if (m.method === "notifications/events/event") {
        return { ...m, params: occurrence(field(m, "params")) }
      }
      if (m.method === CHANNEL) {
        return { jsonrpc: "2.0", method: "notifications/events/event", params: fromChannel(m) }
      }
      return m
    },
  }
}

const refused = (id: unknown, name: string): Json => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: `${name} isn't read-only` }], isError: true },
})

/** Read-only business tools, plus the declared account sign-in/status used privately by Connections. */
export const readOnly = (): Filter => {
  const requests = asked()
  const looks = new Set<string>()
  const auth = new Set<string>()
  return {
    inbound: (m) => {
      if (m.method === "tools/call") {
        const name = String(field(m, "params").name)
        return looks.has(name) ? pass(m) : { forward: null, answer: refused(m.id, name) }
      }
      requests.note(m)
      return pass(m)
    },
    outbound: (m) => {
      const method = requests.take(m)
      if ((method === "initialize" || method === "server/discover") && isJson(m.result)) {
        auth.clear()
        looks.clear()
        const connections = field(field(field(m.result, "capabilities"), "extensions"), CONNECTIONS)
        for (const declared of list(connections.needs).filter(isJson)) {
          if (declared.kind === "key") {
            continue
          }
          const session = field(declared, "session")
          for (const name of [session.signIn, session.status]) {
            if (typeof name === "string" && name !== "") {
              auth.add(name)
            }
          }
        }
      }
      if (method === "tools/list" && isJson(m.result)) {
        looks.clear()
        const tools = list(m.result.tools)
          .filter(isJson)
          .filter(
            (t) =>
              field(t, "annotations").speaksForPerson !== true &&
              (field(t, "annotations").readOnlyHint === true || auth.has(String(t.name))),
          )
          .map((t) =>
            auth.has(String(t.name))
              ? {
                  ...t,
                  _meta: {
                    ...field(t, "_meta"),
                    ui: { ...field(field(t, "_meta"), "ui"), visibility: ["app"] },
                  },
                }
              : t,
          )
        for (const t of tools) {
          looks.add(String(t.name))
        }
        return { ...m, result: { ...m.result, tools } }
      }
      return m
    },
  }
}

/** Filters in order on the way in, reversed on the way out. */
export const chain = (filters: readonly Filter[]): Filter => ({
  inbound: (m) => {
    let current = m
    for (const f of filters) {
      const step = f.inbound(current)
      if (step.forward === null) {
        return step
      }
      current = step.forward
    }
    return pass(current)
  },
  outbound: (m) => {
    let current: Json | null = m
    for (const f of filters.toReversed()) {
      if (current === null) {
        return null
      }
      current = f.outbound(current)
    }
    return current
  },
})
