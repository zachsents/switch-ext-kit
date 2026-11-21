// Messages, whatever extension they come from. An extension's event that is a message carries,
// beside its own payload, who sent it (`sender`: a person or someone's agent) and what it is
// (`message`), in these shapes. Switch knows no extension: the inbox, Contacts' links and the
// tagger read only these.
import type { Json } from "./shim.ts"

export interface Sender {
  /** E.164 phone, lowercase email, or a username: what Contacts matches on. */
  readonly handle: string
  /** What the handle is: "phone", "email", or a service ("instagram", "github"). */
  readonly via: string
  readonly name?: string
  /** The user, sending. */
  readonly me?: boolean
  /** Someone's agent or a machine, not a person. */
  readonly agent?: boolean
  /** Their Contacts id, once linked. */
  readonly person?: string
}

export interface Message {
  /** Stable across updates of the same message (read, relabeled). */
  readonly id: string
  /** Its conversation: a chat, an email thread, a DM thread, a caller. */
  readonly conversation: string
  readonly text: string
  /** When it was sent, ms. */
  readonly at: number
  readonly subject?: string
  /** From someone else, not yet read. */
  readonly unread?: boolean
  /** What it came on, as shown: "texts", "email". */
  readonly channel?: string
}

export const SENDER_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    handle: { type: "string" },
    via: { type: "string" },
    name: { type: "string" },
    me: { type: "boolean" },
    agent: { type: "boolean" },
    person: { type: "string" },
  },
  required: ["handle", "via"],
}

export const MESSAGE_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    id: { type: "string" },
    conversation: { type: "string" },
    text: { type: "string" },
    at: { type: "number" },
    subject: { type: "string" },
    unread: { type: "boolean" },
    channel: { type: "string" },
  },
  required: ["id", "conversation", "text"],
}

const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

export const isSender = (v: unknown): v is Sender =>
  isJson(v) && typeof v.handle === "string" && typeof v.via === "string"

const isMessage = (v: unknown): v is Message =>
  isJson(v) &&
  typeof v.id === "string" &&
  typeof v.conversation === "string" &&
  typeof v.text === "string"

/** A message as the inbox reads it: what it is, who sent it, and its extension. */
export interface Received extends Message {
  readonly sender: Sender
  readonly extension: string
}

/** A stored event as a message, if it is one. `time` stands in for a missing `at`. */
export const messageOf = (type: string, payload: unknown, time: number): Received | null => {
  if (!isJson(payload) || !isSender(payload.sender) || !isMessage(payload.message)) {
    return null
  }
  const m = payload.message
  const extension = type.split(".")[0] ?? ""
  return {
    ...m,
    at: typeof m.at === "number" && m.at > 0 ? m.at : time,
    channel: m.channel ?? extension,
    sender: payload.sender,
    extension,
  }
}
