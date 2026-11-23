// Models for an extension, through the host that runs it: an extension holds no model keys. Its
// requests go to the client over MCP, under the `ax.switch/models` extension, and the core answers
// them with the user's own profile: `models/decide` picks among choices, `models/complete` writes
// text. The same connection carries an extension's action items (`ax.switch/asks`): `asks/open` and
// `asks/close`, and the rest it asks of the host (`Host`): other extensions' tools, the user's
// connections, and brain events it follows.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Context, Deferred, Effect, Layer, Option, Queue, Schema } from "effect"
import type { Cause } from "effect"

import { writeFileAtomic } from "./files.ts"

/** The client capability extension a host declares when it answers model requests. */
export const MODELS = "ax.switch/models"

/** A role in the user's profile, which says what model runs it. */
export type Role = "turn" | "triage" | "gate" | "decision" | "browse"

export interface Choice {
  readonly value: string
  readonly description?: string
}

/** Pick one of `choices`. */
export interface Question {
  readonly instructions: string
  readonly choices: readonly Choice[]
}

/** `stable` goes first and is the same across many calls, so the provider can cache it. */
export interface Input {
  readonly stable: string
  readonly item: string
}

export interface Answer {
  readonly choice: string
  /** Every choice's probability. */
  readonly probabilities: Readonly<Record<string, number>>
}

export interface Decision {
  readonly answers: Readonly<Record<string, Answer>>
  readonly ms: number
  /** Dollars. */
  readonly cost: number
}

export interface Completion {
  readonly text: string
  readonly ms: number
  readonly cost: number
}

const answer = Schema.Struct({
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
})
const decision = Schema.Struct({
  answers: Schema.Record(Schema.String, answer),
  ms: Schema.Number,
  cost: Schema.Number,
})
const completion = Schema.Struct({ text: Schema.String, ms: Schema.Number, cost: Schema.Number })

const TaggedFailure = Schema.TaggedError

const ModelErrorBase: Schema.Class<
  ModelError,
  Schema.TaggedStruct<"ModelError", { readonly message: Schema.String }>,
  Cause.YieldableError
> = TaggedFailure<ModelError>()("ModelError", { message: Schema.String })

/** No host to ask, or the host's model failed. */
export class ModelError extends ModelErrorBase {}

export interface ModelsShape {
  /** Asks the role's model every question about one input, in one call. */
  readonly decide: (
    input: Input,
    questions: Readonly<Record<string, Question>>,
    role?: Role,
  ) => Effect.Effect<Decision, ModelError>
  readonly complete: (
    role: Role,
    system: string,
    prompt: string,
  ) => Effect.Effect<Completion, ModelError>
}

/** The `Models` service's identifier, as a requirement. */
export interface ModelsService {
  readonly Models: unique symbol
}

/** Sends one request to the client and decodes its result. */
export type Send = (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>

/** A brain event an extension follows (`switch/follow`), as the host sends it (`switch/event`). */
export interface Followed {
  readonly seq: number
  readonly id: string
  readonly type: string
  readonly source: string
  readonly time: number
  readonly payload: unknown
}

/** Where `serve` hands over its connection, once the client has said what it offers. */
export interface PeerShape {
  /** `null`: the client answers no model requests. Called again on each new client. */
  readonly attach: (send: Send | null) => void
  /** A brain event it follows, as it comes. */
  readonly heard?: (event: unknown) => void
}

/** The `Peer` service's identifier, as a requirement. */
export interface PeerService {
  readonly Peer: unique symbol
}

export const Peer: Context.Service<PeerService, PeerShape> = Context.Service<
  PeerService,
  PeerShape
>("switch-ext-kit/Peer")

/** How long a call waits for the client to connect before it gives up. */
const CONNECT_MS = 30_000

const failed = (e: unknown) =>
  new ModelError({ message: e instanceof Error ? e.message : String(e) })

const modelsKey: Context.Service<ModelsService, ModelsShape> = Context.Service<
  ModelsService,
  ModelsShape
>("switch-ext-kit/Models")

/** The client capability extension a host declares when it takes an extension's action items. */
export const ASKS = "ax.switch/asks"

/** A draft: words to send in the user's name, editable on the card. */
export interface AskDraft {
  readonly name: string
  readonly label: string
  readonly text: string
}

/** A file on the card: `blob` is its key in the brain's blob store, or `url` a link. */
export interface AskAttachment {
  readonly name: string
  readonly type: string
  readonly size?: number
  readonly blob?: string
  readonly url?: string
  /** Beside this option. */
  readonly option?: number
}

/**
 * An action item an extension puts in the user's queue. `answerTo` names one of its own tools (best
 * `appOnly`) the core calls once it closes: with `{ item, status, answer }`, or for a sealed ask
 * `{ item, use, enc, ct }`, which `openSealed` (switch-ext-kit/sealed) opens with the ask's secret key.
 * A sealed ask's answer reaches only that tool; the brain records only that it was answered.
 */
export interface AskInput {
  readonly title: string
  readonly body: string
  readonly kind?: "task" | "question" | "approval" | "sealed"
  /** Only this extension verifies completion; user dismissal remains available. */
  readonly completion?: "owner"
  /** An explicit action, such as retrying the private challenge. */
  readonly action?: {
    readonly label: string
    readonly app: string
    readonly tool: string
    readonly args?: Readonly<Record<string, unknown>>
  }
  /** Its space; Home when absent. */
  readonly space?: string
  readonly options?: readonly string[]
  readonly drafts?: readonly AskDraft[]
  readonly attachments?: readonly AskAttachment[]
  readonly resolveWhen?: string
  readonly notify?: boolean
  readonly answerTo?: string
  /** A sealed ask's one-time key (`sealedKey().key`) and what the secret is for. */
  readonly sealed?: { readonly key: string; readonly use: string }
}

export interface AsksShape {
  /** Opens it, or revises the open one with `id` (an id this extension gave before). */
  readonly open: (ask: AskInput, id?: string) => Effect.Effect<{ readonly id: string }, ModelError>
  readonly close: (id: string, status: "done" | "dismissed") => Effect.Effect<void, ModelError>
}

/** The `Asks` service's identifier, as a requirement. */
export interface AsksService {
  readonly Asks: unique symbol
}

const asksKey: Context.Service<AsksService, AsksShape> = Context.Service<AsksService, AsksShape>(
  "switch-ext-kit/Asks",
)

const opened = Schema.Struct({ id: Schema.String })

/** What the host does for an extension beyond models and asks. */
export interface HostShape {
  /** Any request to the host, its result decoded. */
  readonly request: <A>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    result: Schema.Codec<A, unknown>,
  ) => Effect.Effect<A, ModelError>
  /** Another extension's tool (`switch/call`), one the manifest's `reaches.calls` names. */
  readonly call: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, ModelError>
  /** The user's connected accounts for a provider the manifest needs. */
  readonly accounts: (provider: string) => Effect.Effect<readonly string[], ModelError>
  /** A fresh token (or key) for one of them. */
  readonly token: (provider: string, account: string) => Effect.Effect<string, ModelError>
  /**
   * The brain's events of `types` (exact, or a prefix ending in `*`), each handled once, in order:
   * the last one handled is kept in `follow.json` in its folder, and following resumes after it on
   * every new client, so a restart on either side misses none.
   */
  readonly follow: (
    types: readonly string[],
    handle: (event: Followed) => Effect.Effect<void>,
  ) => Effect.Effect<void, ModelError>
}

/** The `Host` service's identifier, as a requirement. */
export interface HostService {
  readonly Host: unique symbol
}

const hostKey: Context.Service<HostService, HostShape> = Context.Service<HostService, HostShape>(
  "switch-ext-kit/Host",
)

const followed = Schema.Struct({
  seq: Schema.Finite,
  id: Schema.String,
  type: Schema.String,
  source: Schema.String,
  time: Schema.Finite,
  payload: Schema.Unknown,
})
const decodeFollowed = Schema.decodeUnknownOption(followed)
const accountList = Schema.Struct({
  accounts: Schema.Array(Schema.Struct({ account: Schema.String })),
})
const tokenOf = Schema.Struct({ token: Schema.String })
const record = Schema.Record(Schema.String, Schema.Unknown)
const lastHandled = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ after: Schema.Finite })),
)
const FOLLOW_FILE = "follow.json"

const matches = (patterns: readonly string[], type: string) =>
  patterns.some((p) => (p.endsWith("*") ? type.startsWith(p.slice(0, -1)) : p === type))

const modelsLayer: Layer.Layer<ModelsService | AsksService | HostService | PeerService> =
  Layer.effectContext(
    Effect.gen(function* making() {
      const ready = yield* Deferred.make<Send | null>()
      let current: Send | null = null
      const handlers: {
        readonly types: readonly string[]
        readonly handle: (e: Followed) => Effect.Effect<void>
      }[] = []
      const file = path.resolve(FOLLOW_FILE)
      let after = Option.match(
        existsSync(file) ? lastHandled(readFileSync(file, "utf-8")) : Option.none(),
        { onNone: () => 0, onSome: (x) => x.after },
      )
      const heard = yield* Queue.unbounded<Followed>()
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* handling() {
            const e = yield* Queue.take(heard)
            if (e.seq <= after) {
              return
            }
            for (const h of handlers) {
              if (matches(h.types, e.type)) {
                yield* h.handle(e)
              }
            }
            after = e.seq
            writeFileAtomic(file, JSON.stringify({ after }))
          }),
        ),
      )
      const refollow = (send: Send) => {
        const types = [...new Set(handlers.flatMap((h) => h.types))]
        if (types.length > 0) {
          void send("switch/follow", { types, after }).catch(() => {
            /* the next client follows again */
          })
        }
      }
      const peer: PeerShape = {
        attach: (send) => {
          current = send
          Deferred.doneUnsafe(ready, Effect.succeed(send))
          if (send !== null) {
            refollow(send)
          }
        },
        heard: (raw) => {
          const e = decodeFollowed(raw)
          if (Option.isSome(e)) {
            Queue.offerUnsafe(heard, e.value)
          }
        },
      }
      const ask = <A>(
        method: string,
        params: Readonly<Record<string, unknown>>,
        result: Schema.Codec<A, unknown>,
      ) =>
        Effect.gen(function* asking() {
          const send = yield* Deferred.await(ready).pipe(
            Effect.timeoutOrElse({
              duration: CONNECT_MS,
              orElse: () => Effect.fail(new ModelError({ message: "No host connected" })),
            }),
          )
          const now = current ?? send
          if (now === null) {
            return yield* Effect.fail(new ModelError({ message: "The host offers none" }))
          }
          const raw = yield* Effect.tryPromise({
            try: async () => await now(method, params),
            catch: failed,
          })
          return yield* Schema.decodeUnknownEffect(result)(raw).pipe(Effect.mapError(failed))
        })
      const models: ModelsShape = {
        decide: (input, questions, role = "decision") =>
          ask("models/decide", { input, questions, role }, decision),
        complete: (role, system, prompt) =>
          ask("models/complete", { role, system, prompt }, completion),
      }
      const asks: AsksShape = {
        open: (input, id) =>
          ask("asks/open", { ask: input, ...(id !== undefined && { id }) }, opened),
        close: (id, status) => Effect.asVoid(ask("asks/close", { id, status }, Schema.Unknown)),
      }
      const host: HostShape = {
        request: ask,
        call: (name, args) => ask("switch/call", { name, arguments: args }, record),
        accounts: (provider) =>
          Effect.map(ask("connections/list", { provider }, accountList), (r) =>
            r.accounts.map((a) => a.account),
          ),
        token: (provider, account) =>
          Effect.map(ask("connections/token", { provider, account }, tokenOf), (t) => t.token),
        follow: (types, handle) =>
          Effect.gen(function* following() {
            handlers.push({ types, handle })
            const all = [...new Set(handlers.flatMap((h) => h.types))]
            yield* ask("switch/follow", { types: all, after }, Schema.Unknown)
          }),
      }
      return Context.make(modelsKey, models).pipe(
        Context.add(asksKey, asks),
        Context.add(hostKey, host),
        Context.add(Peer, peer),
      )
    }),
  )

/** The host's other services (calls, connections, follows): provided by `Models.layer`. */
export const Host: Context.Service<HostService, HostShape> & {
  readonly layer: typeof modelsLayer
} = Object.assign(hostKey, { layer: modelsLayer })

/** Action items through the host: provided by `Models.layer`, which `serve` connects. */
export const Asks: Context.Service<AsksService, AsksShape> & {
  readonly layer: typeof modelsLayer
} = Object.assign(asksKey, { layer: modelsLayer })

/** Models through the host: `serve` connects it. */
export const Models: Context.Service<ModelsService, ModelsShape> & {
  readonly layer: typeof modelsLayer
} = Object.assign(modelsKey, { layer: modelsLayer })
