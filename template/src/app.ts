// A starting point: a read-only tool, one that changes something and says so as an event, a widget
// drawn from the read-only tool's result, and the heartbeat its manifest promises. Rename, then
// replace the notes with the real thing.
import { Context, Effect, Layer, Ref, Schema } from "effect"
import {
  AppEvents,
  BASIC_CATALOG,
  defineApp,
  defineEvent,
  SWITCH_CATALOG,
  tool,
} from "switch-ext-kit"
import type { AppEventsService } from "switch-ext-kit"

const note = Schema.Struct({ id: Schema.Finite, text: Schema.String })
type Note = typeof note.Type

export const Added = defineEvent("hello.note_added", 1, Schema.Struct({ note }))

/** Every this often, as its manifest's `heartbeat` promises. */
const BEAT = 5 * 60_000

/**
 * How it is, beaten by what does the work (a sense's loop after each look), so it stops when that
 * does; `failing` says what's wrong now, null when nothing is.
 */
export const Heartbeat = defineEvent(
  "hello.heartbeat",
  1,
  Schema.Struct({
    entity: Schema.Literal("sense:hello"),
    summary: Schema.String,
    facts: Schema.Struct({ failing: Schema.NullOr(Schema.String), notes: Schema.Finite }),
  }),
)

/** What the extension keeps: here in memory; a real one reads the world it watches. */
export class Notes extends Context.Service<
  Notes,
  {
    readonly all: Effect.Effect<readonly Note[]>
    readonly add: (text: string) => Effect.Effect<Note>
  }
>()("hello/Notes") {
  static readonly layer: Layer.Layer<Notes, never, AppEventsService> = Layer.effect(
    Notes,
    Effect.gen(function* making() {
      const events = yield* AppEvents
      const notes = yield* Ref.make<readonly Note[]>([])
      const beat = Effect.gen(function* beating() {
        const n = (yield* Ref.get(notes)).length
        yield* events.emit(
          Heartbeat.make({
            entity: "sense:hello",
            summary: `${n} notes`,
            facts: { failing: null, notes: n },
          }),
        )
      })
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.andThen(Effect.ignore(beat, { log: "Warn" }), Effect.sleep(`${BEAT} millis`)),
        ),
      )
      return {
        all: Ref.get(notes),
        add: (text) =>
          Effect.gen(function* adding() {
            const all = yield* Ref.get(notes)
            const made = { id: all.length + 1, text }
            yield* Ref.set(notes, [...all, made])
            yield* Effect.orDie(events.emit(Added.make({ note: made })))
            return made
          }),
      }
    }),
  )
}

const list = tool("list", { description: "Every note.", readOnly: true }, () =>
  Effect.gen(function* listing() {
    return { notes: yield* (yield* Notes).all }
  }),
)

const add = tool(
  "add",
  { description: "Add a note.", input: Schema.Struct({ text: Schema.String }) },
  (input) =>
    Effect.gen(function* adding() {
      return yield* (yield* Notes).add(input.text)
    }),
)

export const helloApp = defineApp<Notes>({
  name: "hello",
  version: "1",
  instructions: "Notes. What the extension is for, in a line the agent reads.",
  tools: [list, add],
  events: [Added, Heartbeat],
  widgets: [
    {
      name: "notes",
      title: "Notes",
      surfaces: ["space"],
      resource: "ui://hello/notes",
      tool: "list",
      refresh: [Added.type],
      // A line per note: Switch's Line, in a List from A2UI's basic catalog.
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "notes", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "notes",
            components: [
              {
                id: "root",
                component: "List",
                catalogId: BASIC_CATALOG,
                children: { componentId: "line", path: "/notes" },
              },
              { id: "line", component: "Line", label: { "@path": "text" } },
            ],
          },
        },
      ],
    },
  ],
})
