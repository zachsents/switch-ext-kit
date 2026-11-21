// An extension's own event log: its events on its own SQLite file, with read models over them.
// Switch's brain write path, cut down to what an extension needs. That path follows T3 Code's
// orchestration-v2, MIT, Copyright (c) 2026 T3 Tools Inc.: decide, then one transaction for events
// and projections, then publish after commit.
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { Context, Effect, Layer, Option, PubSub, Result, Schema, Semaphore, Stream } from "effect"
import type { Scope } from "effect"

import { Rejected } from "./events.ts"
import type { Check, Draft, EventDef, Payload } from "./events.ts"

/** One row of the log. `payload` is the encoded JSON form. */
export interface StoredEvent {
  readonly seq: number
  readonly id: string
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly payload: unknown
}

/** What a command decides: events to write, or why not. */
export type Decision = { readonly events: readonly Draft[] } | { readonly reject: string }

export interface CommandDef {
  readonly type: string
  readonly handle: (db: Database, payload: unknown) => Decision
}

/** A command as `defineCommand` makes it: typed, with its schema. */
export interface DefinedCommand<T extends string, P, S> extends CommandDef {
  readonly type: T
  readonly payload: Payload<P>
  readonly load: (db: Database, payload: P) => S
  readonly decide: (state: S, payload: P) => Decision
}

/** `load` reads projections; `decide` is pure. Both run in the writer's turn, so nothing interleaves. */
export const defineCommand = <const T extends string, P, S>(def: {
  readonly type: T
  readonly payload: Payload<P>
  readonly load: (db: Database, payload: P) => S
  readonly decide: (state: S, payload: P) => Decision
}): DefinedCommand<T, P, S> => {
  const decode = Schema.decodeUnknownResult(def.payload)
  return {
    ...def,
    handle: (db: Database, raw: unknown): Decision => {
      const p = decode(raw)
      return Result.isSuccess(p)
        ? def.decide(def.load(db, p.success), p.success)
        : { reject: `${def.type}: ${p.failure.message}` }
    },
  }
}

/** How one event type changes a projection's tables. */
export interface On {
  readonly type: string
  readonly apply: (db: Database, event: StoredEvent) => void
}

export const on = <P>(
  def: { readonly type: string; readonly decode: (encoded: unknown) => P },
  apply: (db: Database, payload: P, event: StoredEvent) => void,
): On => ({
  type: def.type,
  apply: (db, event) => {
    apply(db, def.decode(event.payload), event)
  },
})

/** A named read model, updated in the write transaction and rebuilt from the log when its version moves. */
export interface Projection {
  readonly name: string
  /** Bump to rebuild on next open. */
  readonly version: number
  readonly tables: readonly string[]
  readonly create: string
  readonly on: readonly On[]
  readonly snapshot: (db: Database) => unknown
}

export interface LogConfig {
  /** A file path, or ":memory:". */
  readonly path: string
  readonly events: readonly EventDef[]
  readonly projections: readonly Projection[]
  readonly commands: readonly CommandDef[]
}

/** `id` is the caller's: a retry with the same id is a no-op. */
export interface Command {
  readonly id: string
  readonly type: string
  readonly source: string
  readonly payload: unknown
}

export interface Receipt {
  readonly seq: number
  readonly duplicate: boolean
}

export interface Snapshot {
  readonly seq: number
  readonly state: Readonly<Record<string, unknown>>
}

export interface LogShape {
  readonly dispatch: (command: Command) => Effect.Effect<Receipt, Rejected>
  readonly snapshot: Effect.Effect<Snapshot>
  /** Every event after `seq`: the log first, then live, with no gap and no repeat. */
  readonly changes: (seq: number) => Stream.Stream<StoredEvent>
  readonly read: <A>(f: (db: Database) => A) => Effect.Effect<A>
}

/** The `Log` service's identifier, as a requirement. */
export interface LogService {
  readonly Log: unique symbol
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, time INTEGER NOT NULL,
  type TEXT NOT NULL, v INTEGER NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projections (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
`

const PAGE = 1000

interface Row {
  readonly seq: number
  readonly id: string
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly payload: string
}

interface Prepared {
  readonly id: string
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly encoded: unknown
  readonly json: string
}

const parseJson: (json: string) => unknown = JSON.parse

const toStored = (row: Row): StoredEvent => ({ ...row, payload: parseJson(row.payload) })

const checked = (def: { readonly check: Check } | undefined, d: Draft) => {
  if (!def) {
    return new Rejected({ reason: `Unknown type ${d.type}` })
  }
  const result = def.check(d.payload)
  return Result.isSuccess(result)
    ? { encoded: result.success, json: JSON.stringify(result.success) }
    : new Rejected({ reason: `${d.type}: ${result.failure}` })
}

const open = (file: string) => {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true })
  }
  const db = new Database(file, { create: true, strict: true })
  db.run("PRAGMA journal_mode = WAL")
  // WAL with NORMAL survives an app crash; a power cut can lose the last commits.
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run(SCHEMA)
  return db
}

const makeLog = (config: LogConfig): Effect.Effect<LogShape, never, Scope.Scope> =>
  Effect.gen(function* making() {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => open(config.path)),
      (d) =>
        Effect.sync(() => {
          d.close()
        }),
    )

    const eventDefs = new Map(config.events.map((e) => [e.type, e]))
    const commandDefs = new Map(config.commands.map((c) => [c.type, c]))
    const handlers = new Map<string, On[]>()
    for (const o of config.projections.flatMap((p) => p.on)) {
      handlers.set(o.type, [...(handlers.get(o.type) ?? []), o])
    }

    const insertEvent = db.query<{ seq: number }, [string, number, string, number, string, string]>(
      "INSERT INTO events (id, time, type, v, source, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING seq",
    )
    const headQuery = db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events")
    const head = () => headQuery.get()?.seq ?? 0
    const findCommand = db.query<{ seq: number }, [string]>("SELECT seq FROM commands WHERE id = ?")
    const insertCommand = db.query("INSERT INTO commands (id, seq) VALUES (?, ?)")
    const page = db.query<Row, [number, number, number]>(
      "SELECT * FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
    )

    const prepare = (events: readonly (Draft & { id: string; source: string })[]) => {
      const out: Prepared[] = []
      for (const e of events) {
        const def = eventDefs.get(e.type)
        const payload = checked(def, e)
        if (payload instanceof Rejected) {
          return payload
        }
        out.push({
          id: e.id,
          type: e.type,
          source: e.source,
          time: Date.now(),
          v: def?.version ?? 0,
          ...payload,
        })
      }
      return out
    }

    // The one write: events (skipping ids already in the log), projections, receipt.
    const write = db.transaction((events: readonly Prepared[], commandId: string) => {
      const stored: StoredEvent[] = []
      for (const e of events) {
        const row = insertEvent.get(e.id, e.time, e.type, e.v, e.source, e.json)
        if (row !== null) {
          const { id, time, type, v, source } = e
          const event: StoredEvent = { seq: row.seq, id, time, type, v, source, payload: e.encoded }
          for (const h of handlers.get(e.type) ?? []) {
            h.apply(db, event)
          }
          stored.push(event)
        }
      }
      const seq = stored.at(-1)?.seq ?? head()
      insertCommand.run(commandId, seq)
      return { stored, seq }
    })

    const live = yield* PubSub.unbounded<StoredEvent>()
    // Commit and publish under one permit, so subscribers see events in seq order.
    const lane = yield* Semaphore.make(1)

    const decideAndWrite = (command: Command) => {
      const def = commandDefs.get(command.type)
      if (!def) {
        return new Rejected({ reason: `Unknown command ${command.type}` })
      }
      const done = findCommand.get(command.id)
      if (done) {
        return { seq: done.seq, duplicate: true, stored: [] }
      }
      const decision = def.handle(db, command.payload)
      if ("reject" in decision) {
        return new Rejected({ reason: decision.reject })
      }
      const events = prepare(
        decision.events.map((d, i) => ({ ...d, id: `${command.id}:${i}`, source: command.source })),
      )
      if (events instanceof Rejected) {
        return events
      }
      const { stored, seq } = write(events, command.id)
      return { seq, duplicate: false, stored }
    }

    const dispatch = (command: Command) =>
      lane.withPermit(
        Effect.suspend(() => {
          const r = decideAndWrite(command)
          if (r instanceof Rejected) {
            return Effect.fail(r)
          }
          return Effect.as(PubSub.publishAll(live, r.stored), {
            seq: r.seq,
            duplicate: r.duplicate,
          })
        }),
      )

    const since = (after: number, through: number) =>
      Stream.paginate(after, (cursor) =>
        Effect.sync(() => {
          const rows = page.all(cursor, through, PAGE).map(toStored)
          const last = rows.at(-1)
          const next = rows.length === PAGE && last ? Option.some(last.seq) : Option.none()
          return [rows, next] as const
        }),
      )

    // T3 Code's catch-up: subscribe first, then read the head, so nothing falls between.
    const changes = (after: number) =>
      Stream.unwrap(
        Effect.gen(function* subscribing() {
          const subscription = yield* PubSub.subscribe(live)
          const high = Math.max(head(), after)
          return Stream.concat(
            since(after, high),
            Stream.fromSubscription(subscription).pipe(Stream.filter((e) => e.seq > high)),
          )
        }),
      )

    const saveVersion = db.query(
      "INSERT INTO projections (name, version) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET version = excluded.version",
    )
    const rebuild = db.transaction((p: Projection) => {
      for (const table of p.tables) {
        db.run(`DROP TABLE IF EXISTS ${table}`)
      }
      db.run(p.create)
      const types = [...new Set(p.on.map((o) => o.type))]
      const rows = db
        .query<Row, string[]>(
          `SELECT * FROM events WHERE type IN (${types.map(() => "?").join(", ")}) ORDER BY seq`,
        )
        .iterate(...types)
      for (const row of rows) {
        const version = eventDefs.get(row.type)?.version
        if (row.v !== version) {
          throw new Error(`No upcast for ${row.type} v${row.v} to v${version}`)
        }
        const event = toStored(row)
        for (const o of p.on) {
          if (o.type === row.type) {
            o.apply(db, event)
          }
        }
      }
      saveVersion.run(p.name, p.version)
    })
    const versions = db.query<{ version: number }, [string]>(
      "SELECT version FROM projections WHERE name = ?",
    )
    for (const p of config.projections) {
      if (versions.get(p.name)?.version !== p.version) {
        rebuild(p)
      }
    }

    return {
      dispatch,
      snapshot: Effect.sync(() => ({
        seq: head(),
        state: Object.fromEntries(config.projections.map((p) => [p.name, p.snapshot(db)])),
      })),
      changes,
      read: (f) => Effect.sync(() => f(db)),
    } satisfies LogShape
  })

const logKey: Context.Service<LogService, LogShape> = Context.Service<LogService, LogShape>(
  "switch-ext-kit/Log",
)

const logLayer = (config: LogConfig): Layer.Layer<LogService> =>
  Layer.effect(logKey, makeLog(config))

/** An extension's own event log, on its own file. */
export const Log: Context.Service<LogService, LogShape> & {
  /** Opens the log at `config.path`, rebuilding a projection whose version moved. */
  readonly layer: typeof logLayer
} = Object.assign(logKey, { layer: logLayer })
