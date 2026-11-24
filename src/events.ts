// An extension's events: a type, a version and an Effect Schema for the payload. The brain checks
// each one against its schema on the way in; an extension checks it before it's sent.
import { Result, Schema } from "effect"
import type { Cause } from "effect"

/** A payload schema that needs no services, so it can be checked synchronously. */
export type Payload<T> = Schema.Codec<T, unknown>

/**
 * An event before it's in the log: its type and payload, and optionally its own id and time. An
 * id the extension gives (stable for one occurrence) is recorded once however often it's sent.
 */
export interface Draft {
  readonly type: string
  readonly payload: unknown
  readonly id?: string
  /** When it happened, as an ISO instant; else when it's emitted. */
  readonly time?: string
}

/** Checks a payload against its schema and returns its encoded form, or why it failed. */
export type Check = (payload: unknown) => Result.Result<unknown, string>

export const checker = <P>(schema: Payload<P>): Check => {
  const decode = Schema.decodeUnknownResult(schema)
  const encode = Schema.encodeSync(schema)
  return (payload) =>
    Result.mapBoth(decode(payload), { onSuccess: encode, onFailure: (e) => e.message })
}

/** An event type with its payload type erased. */
export interface EventDef {
  readonly type: string
  readonly version: number
  readonly check: Check
}

/** An event type as `defineEvent` makes it: typed, with its schema, decoder and maker. */
export interface DefinedEvent<T extends string, P> extends EventDef {
  readonly type: T
  readonly payload: Payload<P>
  readonly decode: (encoded: unknown) => P
  readonly make: (p: P) => Draft
}

export const defineEvent = <const T extends string, P>(
  type: T,
  version: number,
  payload: Payload<P>,
): DefinedEvent<T, P> => ({
  type,
  version,
  payload,
  check: checker(payload),
  decode: Schema.decodeUnknownSync(payload),
  make: (p: P): Draft => ({ type, payload: p }),
})

const TaggedRefusal = Schema.TaggedError

const RejectedBase: Schema.Class<
  Rejected,
  Schema.TaggedStruct<
    "Rejected",
    {
      readonly reason: Schema.String
      readonly check: Schema.optionalKey<Schema.Boolean>
    }
  >,
  Cause.YieldableError
> = TaggedRefusal<Rejected>()("Rejected", {
  reason: Schema.String,
  check: Schema.optionalKey(Schema.Boolean),
})

/**
 * Something refused: a bad payload, an unknown type, or a decision that said no. `check`: a check
 * said no to what the caller sent, so the tool worked; its answer is marked `REFUSED`, which no one
 * counts as the extension failing.
 */
export class Rejected extends RejectedBase {}
