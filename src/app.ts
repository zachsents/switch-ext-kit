// The app convention: tools as MCP tools, events as MCP Events (SEP-3415, push delivery) with an
// Effect Schema and a version, widgets as A2UI (v1.0): `ui://` resources holding A2UI messages, each
// listed with its descriptor. Custom drawing is an MCP App inside, in A2UI's `McpApp` component.
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { McpServer, ProtocolError } from "@modelcontextprotocol/server"
import type {
  CallToolResult,
  StandardSchemaWithJSON,
  Transport,
} from "@modelcontextprotocol/server"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Option,
  PubSub,
  Result,
  Schema,
} from "effect"
import type { Scope } from "effect"

import { Rejected } from "./events.ts"
import type { Need } from "./manifest.ts"
import type { Draft, EventDef } from "./events.ts"
import { Peer } from "./models.ts"
import { uiEvents } from "./ui.ts"

export const EVENTS = "io.modelcontextprotocol/events"
export const SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId"
/** An event type's version, in its `events/list` entry. */
export const VERSION = "ax.switch/version"
/** The connections an app needs, in its server capabilities' extensions. */
export const CONNECTIONS = "ax.switch/connections"
/**
 * What an extension reaches beyond itself, in its handshake: other extensions' tools it calls
 * (`switch/call`) and the brain's event types it follows (`switch/follow`), each a name or a
 * prefix ending in `*`. Nothing else is answered.
 */
export const REACHES = "ax.switch/reaches"
/**
 * Who asked for a tool call, in its `_meta`: the thread of the work that called it and that work's
 * space. The core sets it on an agent's call, and passes on what an extension calling another's tool
 * (`switch/call`) gives as its own call's.
 */
export const CALLER = "ax.switch/caller"
export interface CallerShape {
  readonly thread: string | null
  readonly space: string | null
}
/** The work that asked for the tool call running now; nulls when the core didn't say. */
export const Caller: Context.Reference<CallerShape> = Context.Reference<CallerShape>(CALLER, {
  defaultValue: () => ({ thread: null, space: null }),
})
const callerOf = Schema.decodeUnknownOption(
  Schema.Struct({
    [CALLER]: Schema.Struct({
      thread: Schema.NullOr(Schema.String),
      space: Schema.NullOr(Schema.String),
    }),
  }),
)
/**
 * Tells whoever called the running tool how it's going (MCP's `notifications/progress`, when the
 * call asked with a `progressToken`): a line of words, and how far along, else one step more.
 */
export type ProgressShape = (
  message: string,
  progress?: number,
  total?: number,
) => Effect.Effect<void>
export const Progress: Context.Reference<ProgressShape> = Context.Reference<ProgressShape>(
  "ax.switch/progress",
  { defaultValue: () => () => Effect.void },
)
const progressTokenOf = Schema.decodeUnknownOption(
  Schema.Struct({ progressToken: Schema.Union([Schema.String, Schema.Finite]) }),
)

/**
 * A tool call made once, in its `_meta`: a stable id (an item's answer to the extension that raised
 * it, say). The kit runs the tool once per id, across restarts (in the outbox's file): the same id
 * again answers that it ran, and one cut off partway (the extension stopped) isn't run again but
 * answers that it may have run. Every extension dedupes this way without code of its own.
 */
export const ONCE = "ax.switch/once"
const onceOf = Schema.decodeUnknownOption(Schema.Struct({ [ONCE]: Schema.String }))

/**
 * A tool's answer that's a check's refusal (`Rejected` with `check`), in its `_meta`: an error the
 * caller fixes, never a sign the extension is failing.
 */
export const REFUSED = "ax.switch/refused"

/** A widget's descriptor, in its `ui://` resource's `resources/list` entry. */
export const WIDGET = "ax.switch/widget"
/** What a widget's resource holds: a JSON array of A2UI messages. */
export const A2UI_MIME_TYPE = "application/a2ui+json"

/** A brain event an app publishes: `defineEvent`'s result. */
export interface AppEvent extends EventDef {
  readonly payload: Schema.Top
}

export interface Tool<R> {
  readonly name: string
  readonly description: string
  readonly readOnly: boolean
  /** It sends something out in the user's name: the Outbound gate reads it first. */
  readonly speaks: boolean
  /** Only the user's clients call it, never the agent (MCP Apps' `visibility: ["app"]`). */
  readonly appOnly: boolean
  readonly input: StandardSchemaWithJSON | undefined
  readonly run: (input: unknown) => Effect.Effect<unknown, unknown, R>
}

const standard = (schema: Schema.Codec<unknown, unknown>): StandardSchemaWithJSON =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))

interface ToolOptions {
  readonly description: string
  /** It only looks, changing nothing. */
  readonly readOnly?: boolean
  /** It sends something out in the user's name (a text, an email, a call). */
  readonly speaks?: boolean
  /** Only the user's clients call it, never the agent. */
  readonly appOnly?: boolean
}

/** A tool fails with a `Rejected`, or any error whose message is what went wrong. */
export function tool<I, A, E, R>(
  name: string,
  options: ToolOptions & { readonly input: Schema.Codec<I, unknown> },
  run: (input: I) => Effect.Effect<A, E, R>,
): Tool<R>
export function tool<A, E, R>(
  name: string,
  options: ToolOptions,
  run: () => Effect.Effect<A, E, R>,
): Tool<R>
export function tool<R>(
  name: string,
  options: ToolOptions & { readonly input?: Schema.Codec<unknown, unknown> },
  run: (input?: unknown) => Effect.Effect<unknown, unknown, R>,
): Tool<R> {
  const { input } = options
  return {
    name,
    description: options.description,
    readOnly: options.readOnly === true,
    speaks: options.speaks === true,
    appOnly: options.appOnly === true,
    input: input && standard(input),
    run: input ? (raw) => Effect.flatMap(Schema.decodeUnknownEffect(input)(raw), run) : () => run(),
  }
}

/** Where a widget can show. */
export type Surface = "chat" | "space" | "liveActivity" | "wallet"
const surface = Schema.Literals(["chat", "space", "liveActivity", "wallet"])

/** A widget's shape: kept square, wider than tall, taller than wide, or as its content needs. */
export type Aspect = "square" | "wide" | "tall" | "auto"

/** A size in grid units: a unit is one square cell of the host's grid. */
export interface Units {
  readonly cols: number
  readonly rows: number
}

/** How a widget sits in a space's grid. */
export interface Size {
  readonly aspect: Aspect
  /** The width over height a wide or tall one keeps: 16 / 9. */
  readonly ratio?: number
  readonly min?: Units
  readonly preferred?: Units
  /** The most it takes, however much room there is: a watch face stays watch-sized. */
  readonly max?: Units
  /** It may take more than `preferred`, up to `max`: made bigger, or filling room left over. */
  readonly grows?: boolean
  /** With nothing to show (its view draws only an empty state): a single line, or hidden. */
  readonly empty?: "line" | "hide"
}

const count = Schema.Int.check(Schema.isGreaterThan(0))
const units = Schema.Struct({ cols: count, rows: count })

export const size: Schema.Codec<Size> = Schema.Struct({
  aspect: Schema.Literals(["square", "wide", "tall", "auto"]),
  ratio: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  min: Schema.optionalKey(units),
  preferred: Schema.optionalKey(units),
  max: Schema.optionalKey(units),
  grows: Schema.optionalKey(Schema.Boolean),
  empty: Schema.optionalKey(Schema.Literals(["line", "hide"])),
})

/** A setting the user picks per placement of a widget: one of a few options. The host keeps the
 * choice with the placement and calls the widget's tool with it, under `key`. */
export interface WidgetSetting {
  readonly key: string
  readonly label: string
  readonly options: readonly { readonly value: string; readonly label: string }[]
  /** Its value until the user picks one. */
  readonly initial: string
}

export const widgetSetting: Schema.Codec<WidgetSetting> = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  options: Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })),
  initial: Schema.String,
})

/** A descriptor only: what it is, where it can show, its view, and the data feeding it, if any. */
export interface Widget {
  readonly name: string
  readonly title: string
  readonly surfaces: readonly Surface[]
  /** Its content: a `ui://` resource of A2UI messages. */
  readonly resource: string
  /** The read-only tool whose structured result is its data model, and the events that refresh it. */
  readonly tool?: string
  readonly refresh?: readonly string[]
  /** How it sits in a space's grid; none is `auto`. */
  readonly size?: Size
  /** What the user can set on each placement, passed to its tool. */
  readonly settings?: readonly WidgetSetting[]
}

export const widget: Schema.Codec<Widget> = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  surfaces: Schema.Array(surface),
  /** Its content: a `ui://` resource of A2UI messages. */
  resource: Schema.String,
  /** The read-only tool whose structured result is its data model, and the events that refresh it. */
  tool: Schema.optionalKey(Schema.String),
  refresh: Schema.optionalKey(Schema.Array(Schema.String)),
  /** How it sits in a space's grid; none is `auto`. */
  size: Schema.optionalKey(size),
  /** What the user can set on each placement, passed to its tool. */
  settings: Schema.optionalKey(Schema.Array(widgetSetting)),
})

/** A widget as its app defines it: the descriptor, and its A2UI messages (one surface, any id). */
export interface WidgetDef extends Widget {
  readonly a2ui: () => readonly unknown[] | Promise<readonly unknown[]>
}

const descriptor = ({ a2ui: _, ...w }: WidgetDef): Widget => w

export interface App<R = never> {
  readonly name: string
  readonly version: string
  readonly instructions?: string
  readonly connections: readonly Need[]
  /** What it reaches beyond itself (`REACHES`): tools it calls, brain event types it follows. */
  readonly reaches?: Reaches
  readonly tools: readonly Tool<R>[]
  /** Its own events plus the UI analytics family, which every app publishes. */
  readonly events: readonly AppEvent[]
  readonly widgets: readonly WidgetDef[]
}

/** Tools an extension calls (`switch/call`) and brain event types it follows (`switch/follow`). */
export interface Reaches {
  readonly calls?: readonly string[]
  readonly follows?: readonly string[]
}

export const defineApp = <R = never>(app: {
  readonly name: string
  readonly version: string
  readonly instructions?: string
  readonly connections?: readonly Need[]
  readonly reaches?: Reaches
  readonly tools: readonly Tool<R>[]
  readonly events?: readonly AppEvent[]
  readonly widgets?: readonly WidgetDef[]
}): App<R> => {
  const events = app.events ?? []
  for (const e of events) {
    if (!e.type.startsWith(`${app.name}.`)) {
      throw new Error(`${app.name}'s event ${e.type} must start with "${app.name}."`)
    }
  }
  const widgets = app.widgets ?? []
  for (const w of widgets) {
    if (!w.resource.startsWith("ui://")) {
      throw new Error(`Widget ${w.name}'s view must be a ui:// resource`)
    }
    const fed = app.tools.find((t) => t.name === w.tool)
    if (w.tool !== undefined && fed?.readOnly !== true) {
      throw new Error(`Widget ${w.name} needs a read-only tool ${w.tool}`)
    }
  }
  return { ...app, connections: app.connections ?? [], events: [...events, ...uiEvents], widgets }
}

/** One MCP Events occurrence. `cursor` is its place in the extension's outbox. */
export interface Occurrence {
  readonly eventId: string
  readonly name: string
  readonly timestamp: string
  readonly data: unknown
  readonly cursor: string
}

/**
 * The client takes events in (`ACK`, `{ cursors }`): each one it has kept for good. Until then
 * an event stays in the extension's outbox and is sent again on the next `events/stream` of its type,
 * so the client keeps it once however often it's sent (by its `eventId`).
 */
export const ACK = "notifications/events/ack"

/** Events of one type an outbox keeps unacknowledged; past it, the oldest go. */
const KEPT = 10_000

const OUTBOX = `
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, name TEXT NOT NULL,
  timestamp TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS outbox_name ON outbox (name, seq);
CREATE TABLE IF NOT EXISTS once (id TEXT PRIMARY KEY, finished INTEGER NOT NULL);
`

/** Tool calls made once that it remembers; past it, the oldest go. */
const ONCE_KEPT = 10_000

/** What an `events/stream` sends: the type's events not yet acknowledged, then each one as it's emitted. */
export interface Subscribed {
  readonly backlog: readonly Occurrence[]
  /** Live occurrences of any type; those at or before `through` are in the backlog already. */
  readonly live: PubSub.Subscription<Occurrence>
  readonly through: number
}

/** How an app emits its events, to whoever subscribed (the gateway). */
export interface AppEventsShape {
  /** Kept in the outbox before it returns, so it reaches the client even across a restart. */
  readonly emit: (draft: Draft) => Effect.Effect<void, Rejected>
  readonly subscribe: (name: string) => Effect.Effect<Subscribed, never, Scope.Scope>
  /** The client kept these: they leave the outbox. */
  readonly ack: (cursors: readonly string[]) => Effect.Effect<void>
  /**
   * A call made once (`ONCE`) begins: null when it's new, and it's recorded as begun; else whether
   * the first one finished (not when it was cut off partway).
   */
  readonly claim: (id: string) => Effect.Effect<{ readonly finished: boolean } | null>
  /** A call made once finished. */
  readonly settle: (id: string) => Effect.Effect<void>
}

/** The `AppEvents` service's identifier, as a requirement. */
export interface AppEventsService {
  readonly AppEvents: unique symbol
}

const appEventsKey: Context.Service<AppEventsService, AppEventsShape> = Context.Service<
  AppEventsService,
  AppEventsShape
>("switch/AppEvents")

interface OutboxRow {
  readonly seq: number
  readonly id: string
  readonly name: string
  readonly timestamp: string
  readonly data: string
}

const parseJson: (json: string) => unknown = JSON.parse

const toOccurrence = (r: OutboxRow): Occurrence => ({
  eventId: r.id,
  name: r.name,
  timestamp: r.timestamp,
  data: parseJson(r.data),
  cursor: String(r.seq),
})

const openOutbox = (file: string) => {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true })
  }
  const db = new Database(file, { create: true, strict: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run(OUTBOX)
  return db
}

const appEventsLayer = (
  app: { readonly events: readonly AppEvent[] },
  file = ":memory:",
): Layer.Layer<AppEventsService> =>
  Layer.effect(
    appEventsKey,
    Effect.gen(function* making() {
      const defs = new Map(app.events.map((e) => [e.type, e]))
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => openOutbox(file)),
        (d) =>
          Effect.sync(() => {
            d.close()
          }),
      )
      const insert = db.query<{ seq: number }, [string, string, string, string]>(
        "INSERT INTO outbox (id, name, timestamp, data) VALUES (?, ?, ?, ?) RETURNING seq",
      )
      const trim = db.query<unknown, [string, string, number]>(
        "DELETE FROM outbox WHERE name = ? AND seq <= (SELECT seq FROM outbox WHERE name = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      )
      const pending = db.query<OutboxRow, [string]>(
        "SELECT * FROM outbox WHERE name = ? ORDER BY seq",
      )
      const last = db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM outbox")
      const remove = db.query<unknown, [number]>("DELETE FROM outbox WHERE seq = ?")
      const removeAll = db.transaction((seqs: readonly number[]) => {
        for (const seq of seqs) {
          remove.run(seq)
        }
      })
      const live = yield* PubSub.unbounded<Occurrence>()
      const claimed = db.query<{ finished: number }, [string]>(
        "SELECT finished FROM once WHERE id = ?",
      )
      const begin = db.query<unknown, [string]>("INSERT INTO once (id, finished) VALUES (?, 0)")
      const trimOnce = db.query<unknown, [number]>(
        "DELETE FROM once WHERE rowid <= (SELECT rowid FROM once ORDER BY rowid DESC LIMIT 1 OFFSET ?)",
      )
      const finish = db.query<unknown, [string]>("UPDATE once SET finished = 1 WHERE id = ?")

      const emit = (draft: Draft) =>
        Effect.suspend(() => {
          const def = defs.get(draft.type)
          if (!def) {
            return Effect.fail(new Rejected({ reason: `Unknown type ${draft.type}` }))
          }
          const checked = def.check(draft.payload)
          if (Result.isFailure(checked)) {
            return Effect.fail(new Rejected({ reason: `${draft.type}: ${checked.failure}` }))
          }
          const eventId = draft.id ?? randomUUID()
          const timestamp = draft.time ?? new Date().toISOString()
          const data = JSON.stringify(checked.success)
          const row = insert.get(eventId, draft.type, timestamp, data)
          trim.run(draft.type, draft.type, KEPT)
          const occurrence: Occurrence = {
            eventId,
            name: draft.type,
            timestamp,
            data: checked.success,
            cursor: String(row?.seq ?? 0),
          }
          return Effect.asVoid(PubSub.publish(live, occurrence))
        })

      // Subscribed first, then the outbox read, so nothing falls between the two.
      const subscribe = (name: string) =>
        Effect.gen(function* subscribing() {
          const subscription = yield* PubSub.subscribe(live)
          return {
            backlog: pending.all(name).map(toOccurrence),
            live: subscription,
            through: last.get()?.seq ?? 0,
          }
        })

      const ack = (cursors: readonly string[]) =>
        Effect.sync(() => {
          removeAll(cursors.map(Number).filter(Number.isInteger))
        })

      const claim = (id: string) =>
        Effect.sync(() => {
          const was = claimed.get(id)
          if (was !== null) {
            return { finished: was.finished === 1 }
          }
          begin.run(id)
          trimOnce.run(ONCE_KEPT)
          return null
        })

      const settle = (id: string) =>
        Effect.sync(() => {
          finish.run(id)
        })

      return { emit, subscribe, ack, claim, settle }
    }),
  )

export const AppEvents: Context.Service<AppEventsService, AppEventsShape> & {
  /**
   * Emits `app`'s events through an outbox on `file` (in memory unless given), each kept until the
   * client acknowledges it.
   */
  readonly layer: typeof appEventsLayer
} = Object.assign(appEventsKey, { layer: appEventsLayer })

const describe = (error: unknown): string => {
  if (error instanceof Rejected) {
    return error.reason
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const ANSWER: unique symbol = Symbol("answer")

/** A tool's answer with content of its own (an image, say) beside its structured result. */
export interface Answer {
  readonly [ANSWER]: true
  readonly structured: Record<string, unknown>
  readonly content: CallToolResult["content"]
}

export const answer = (
  structured: Record<string, unknown>,
  content: CallToolResult["content"],
): Answer => ({ [ANSWER]: true, structured, content })

const isAnswer = (value: unknown): value is Answer =>
  typeof value === "object" && value !== null && ANSWER in value

const toResult = (value: unknown): CallToolResult => {
  if (isAnswer(value)) {
    return { content: value.content, structuredContent: value.structured }
  }
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] }
  }
  const text = JSON.stringify(value ?? null)
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { content: [{ type: "text", text }], structuredContent: value }
    : { content: [{ type: "text", text }] }
}

/** What a tool that failed answers. */
const failed = (failure: unknown) =>
  Effect.succeed<CallToolResult>({
    content: [{ type: "text", text: describe(failure) }],
    isError: true,
    ...(failure instanceof Rejected && failure.check === true && { _meta: { [REFUSED]: true } }),
  })

/** A call made once, again: it ran, or was cut off partway and isn't run again, as it may have acted. */
const again = (name: string, finished: boolean): CallToolResult =>
  finished
    ? { content: [{ type: "text", text: `${name} already ran for this.` }] }
    : {
        content: [
          {
            type: "text",
            text: `${name} was already running for this when the extension stopped, so whether it finished is unknown. It isn't run again.`,
          },
        ],
        isError: true,
      }

const anything = Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Unknown))
const streamParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    name: Schema.String,
    heartbeatMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  }),
)

const ackParams = Schema.toStandardSchemaV1(Schema.Struct({ cursors: Schema.Array(Schema.String) }))

const jsonSchema = (schema: Schema.Top) => {
  const doc = Schema.toJsonSchemaDocument(schema)
  return Object.keys(doc.definitions).length > 0
    ? { ...doc.schema, $defs: doc.definitions }
    : doc.schema
}

/** Serves an app over MCP on `transport` until the scope closes. Returns what waits for the client to go. */
export const serve: <R>(
  app: App<R>,
  transport: Transport,
) => Effect.Effect<Effect.Effect<void>, never, R | AppEventsService | Scope.Scope> =
  Effect.fnUntraced(function* serving<R>(app: App<R>, transport: Transport) {
    const events = yield* AppEvents
    const run = yield* FiberSet.makeRuntimePromise<R | AppEventsService>()
    const mcp = new McpServer(
      { name: app.name, version: app.version },
      {
        capabilities: {
          tools: {},
          resources: {},
          extensions: {
            [EVENTS]: { listChanged: false },
            ...(app.connections.length > 0 && {
              [CONNECTIONS]: {
                needs: app.connections.map((n) => ({ ...n, scopes: [...n.scopes] })),
              },
            }),
            ...(app.reaches !== undefined && {
              [REACHES]: {
                ...(app.reaches.calls !== undefined && { calls: [...app.reaches.calls] }),
                ...(app.reaches.follows !== undefined && { follows: [...app.reaches.follows] }),
              },
            }),
          },
        },
        ...(app.instructions === undefined ? {} : { instructions: app.instructions }),
      },
    )

    const inFlight = new Map<string, Promise<CallToolResult>>()
    for (const t of app.tools) {
      // A tool names the UI resource its results show in (MCP Apps' field, which A2UI's MCP catalog
      // reads too); a tool feeding several widgets names the first.
      const fed = app.widgets.find((w) => w.tool === t.name)
      const config = {
        description: t.description,
        annotations: { readOnlyHint: t.readOnly, ...(t.speaks && { speaksForPerson: true }) },
        _meta: {
          ui: {
            ...(fed && { resourceUri: fed.resource }),
            ...(t.appOnly && { visibility: ["app"] }),
          },
        },
      }
      const call = async (
        input: unknown,
        meta: unknown,
        notify: (n: { method: string; params: Record<string, unknown> }) => Promise<void>,
      ) => {
        let done = 0
        const progress: ProgressShape = (message, at, total) =>
          Option.match(progressTokenOf(meta), {
            onNone: () => Effect.void,
            onSome: ({ progressToken }) =>
              Effect.promise(async () => {
                done = at ?? done + 1
                await notify({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: done,
                    message,
                    ...(total !== undefined && { total }),
                  },
                }).catch(() => {
                  /* the caller went */
                })
              }),
          })
        const answering = t.run(input).pipe(
          Effect.provideService(Progress, progress),
          Effect.provideService(
            Caller,
            Option.match(callerOf(meta), {
              onNone: () => Caller.defaultValue(),
              onSome: (m) => m[CALLER],
            }),
          ),
          Effect.map(toResult),
          Effect.catch(failed),
        )
        const id = Option.getOrNull(onceOf(meta))?.[ONCE] ?? null
        if (id === null) {
          return await run(answering)
        }
        // The same id while its first call runs waits for that one.
        const key = `${t.name}\n${id}`
        const under = inFlight.get(key)
        if (under !== undefined) {
          return await under
        }
        const first = run(
          Effect.gen(function* onceOnly() {
            const was = yield* events.claim(key)
            if (was !== null) {
              return again(t.name, was.finished)
            }
            const out = yield* answering
            yield* events.settle(key)
            return out
          }),
        )
        inFlight.set(key, first)
        try {
          return await first
        } finally {
          inFlight.delete(key)
        }
      }
      if (t.input) {
        mcp.registerTool(
          t.name,
          { ...config, inputSchema: t.input },
          async (input, ctx) => await call(input, ctx.mcpReq._meta, ctx.mcpReq.notify),
        )
      } else {
        mcp.registerTool(
          t.name,
          config,
          async (ctx) => await call({}, ctx.mcpReq._meta, ctx.mcpReq.notify),
        )
      }
    }

    for (const w of app.widgets) {
      mcp.registerResource(
        w.title,
        w.resource,
        { mimeType: A2UI_MIME_TYPE, _meta: { [WIDGET]: descriptor(w) } },
        async () => ({
          contents: [
            { uri: w.resource, mimeType: A2UI_MIME_TYPE, text: JSON.stringify(await w.a2ui()) },
          ],
        }),
      )
    }

    const list = app.events.map((e) => ({
      name: e.type,
      description: "",
      delivery: ["push"],
      inputSchema: { type: "object", properties: {} },
      payloadSchema: jsonSchema(e.payload),
      _meta: { [VERSION]: e.version },
    }))
    mcp.server.setRequestHandler("events/list", { params: anything }, () => ({ events: list }))

    // A push subscription: confirm, then the type's events not yet acknowledged, then each one as
    // it's emitted, with a heartbeat when quiet, until the client cancels.
    mcp.server.setRequestHandler("events/stream", { params: streamParams }, async (params, ctx) => {
      if (!app.events.some((e) => e.type === params.name)) {
        throw new ProtocolError(-32_023, "NotFound", { kind: "event" })
      }
      const heartbeatMs = Math.max(5000, Math.min(params.heartbeatMs ?? 30_000, 300_000))
      const meta = { [SUBSCRIPTION]: ctx.mcpReq.id }
      const notify = (method: string, p: Record<string, unknown>) =>
        Effect.promise(async () => {
          await ctx.mcpReq.notify({ method, params: { ...p, _meta: meta } })
        })
      return await run(
        Effect.scoped(
          Effect.gen(function* streaming() {
            const { backlog, live, through } = yield* events.subscribe(params.name)
            yield* notify("notifications/events/active", {
              cursor: null,
              truncated: false,
              heartbeatMs,
            })
            for (const o of backlog) {
              yield* notify("notifications/events/event", { ...o })
            }
            for (;;) {
              const next = yield* Effect.timeoutOption(PubSub.take(live), heartbeatMs)
              if (Option.isNone(next)) {
                yield* notify("notifications/events/heartbeat", { cursor: null })
              } else if (next.value.name === params.name && Number(next.value.cursor) > through) {
                yield* notify("notifications/events/event", { ...next.value })
              }
            }
          }),
        ),
        { signal: ctx.mcpReq.signal },
      ).then(() => ({ _meta: meta }))
    })
    mcp.server.setNotificationHandler(ACK, { params: ackParams }, async (params) => {
      await run(events.ack(params.cursors))
    })

    const closed = yield* Deferred.make<boolean>()
    // Models through the client, once it's connected. A client that doesn't answer them (no
    // `ax.switch/models`) fails each request, and the call with it.
    const peer = yield* Effect.serviceOption(Peer)
    const send = async (method: string, params: Readonly<Record<string, unknown>>) =>
      await mcp.server.request({ method, params: { ...params } }, anything)
    // MCP's own hooks, not DOM targets.
    Object.assign(mcp.server, {
      onclose: () => {
        Deferred.doneUnsafe(closed, Exit.succeed(true))
      },
      oninitialized: () => {
        if (Option.isSome(peer)) {
          peer.value.attach(send)
        }
      },
    })
    mcp.server.setNotificationHandler("switch/event", { params: anything }, (params) => {
      if (Option.isSome(peer)) {
        peer.value.heard?.(params)
      }
    })
    yield* Effect.acquireRelease(
      Effect.promise(async () => {
        await mcp.connect(transport)
      }),
      () =>
        Effect.promise(async () => {
          await mcp.close()
        }),
    )
    return Effect.asVoid(Deferred.await(closed))
  })
