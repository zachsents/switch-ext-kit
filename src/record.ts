// The events of an extension ported from a Switchboard appendage, as the shim made them: each type
// version 1, its payload the appendage's record (`kind`, `stream`, its body as `data`, and the
// envelope's `about`, `refs`, `importance`, `sender` and `message`), its id the record's own when it
// gives one. A port emits these, so what lands in the brain is what landed before.
import { Schema } from "effect"

import { defineEvent } from "./events.ts"
import type { DefinedEvent, Draft } from "./events.ts"
import type { Message, Sender } from "./messages.ts"

export const RecordPayload: Schema.Codec<RecordShape, unknown> = Schema.Struct({
  kind: Schema.String,
  stream: Schema.String,
  data: Schema.Unknown,
  about: Schema.optionalKey(Schema.Array(Schema.String)),
  refs: Schema.optionalKey(Schema.Array(Schema.String)),
  importance: Schema.optionalKey(Schema.Finite),
  sender: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(Schema.Unknown),
})

export interface RecordShape {
  readonly kind: string
  readonly stream: string
  readonly data: unknown
  readonly about?: readonly string[]
  readonly refs?: readonly string[]
  readonly importance?: number
  readonly sender?: unknown
  readonly message?: unknown
}

/** What an appendage's `emit` took beside the body. */
export interface Envelope {
  readonly about?: readonly string[]
  readonly refs?: readonly string[]
  readonly importance?: number
  /** The record's own id: the event's id, so emitting it again is one event. */
  readonly id?: string
  /** Where this occurrence lands, within its type's. */
  readonly stream?: string
  readonly sender?: Sender
  readonly message?: Message
  /** The event's id when the record has none (`event_id`). */
  readonly eventId?: string
  /** When it happened, as an ISO instant. */
  readonly at?: string
}

export interface RecordEvent<T extends string> extends DefinedEvent<T, RecordShape> {
  /** One occurrence: its body and envelope as the appendage's `emit` took them. */
  readonly record: (data: unknown, envelope?: Envelope) => Draft
}

/**
 * `<extension>.<name>`, landing as `kind` in `stream` (the appendage's `event()` placement; else an
 * `event` in `events/<extension>`).
 */
export const defineRecord = <const T extends string>(
  type: T,
  placed: { readonly kind?: string; readonly stream?: string } = {},
): RecordEvent<T> => {
  const def = defineEvent(type, 1, RecordPayload)
  const extension = type.slice(0, type.indexOf("."))
  return {
    ...def,
    record: (data, envelope = {}) => {
      const { id, eventId, at, stream, ...rest } = envelope
      const payload: RecordShape = {
        ...rest,
        kind: placed.kind ?? "event",
        stream: stream ?? placed.stream ?? `events/${extension}`,
        data: data ?? null,
      }
      const given = id ?? eventId
      return {
        type,
        payload,
        ...(given !== undefined && { id: given }),
        ...(at !== undefined && { time: at }),
      }
    },
  }
}
