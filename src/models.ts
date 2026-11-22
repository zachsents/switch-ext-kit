// Models for an extension, through the host that runs it: an extension holds no model keys. Its
// requests go to the client over MCP, under the `ax.switch/models` extension, and the core answers
// them with the user's own profile: `models/decide` picks among choices, `models/complete` writes
// text. The same connection carries an extension's action items (`ax.switch/asks`): `asks/open` and
// `asks/close`.
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import type { Cause } from "effect"

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

/** Where `serve` hands over its connection, once the client has said what it offers. */
export interface PeerShape {
  /** `null`: the client answers no model requests. */
  readonly attach: (send: Send | null) => void
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

const modelsLayer: Layer.Layer<ModelsService | AsksService | PeerService> = Layer.effectContext(
  Effect.gen(function* making() {
    const ready = yield* Deferred.make<Send | null>()
    const peer: PeerShape = {
      attach: (send) => {
        Deferred.doneUnsafe(ready, Effect.succeed(send))
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
        if (send === null) {
          return yield* Effect.fail(new ModelError({ message: "The host offers none" }))
        }
        const raw = yield* Effect.tryPromise({
          try: async () => await send(method, params),
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
    return Context.make(modelsKey, models).pipe(Context.add(asksKey, asks), Context.add(Peer, peer))
  }),
)

/** Action items through the host: provided by `Models.layer`, which `serve` connects. */
export const Asks: Context.Service<AsksService, AsksShape> & {
  readonly layer: typeof modelsLayer
} = Object.assign(asksKey, { layer: modelsLayer })

/** Models through the host: `serve` connects it. */
export const Models: Context.Service<ModelsService, ModelsShape> & {
  readonly layer: typeof modelsLayer
} = Object.assign(modelsKey, { layer: modelsLayer })
