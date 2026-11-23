# switch-ext-kit

The convention for Switch extensions: an extension's tools (MCP tools), events (MCP Events, with an Effect
Schema and a version), widgets (A2UI, with `McpApp` for custom drawing), its manifest, and serving
it as MCP on stdio. Also the shim that makes a Switchboard appendage an extension.

## Install

```sh
bun add github:zachsents/switch-ext-kit effect
```

## What an extension is

One general capability that makes repeated work efficient: not a category (travel, errands), and
not a one-off site script (a one-off is done with the general extensions, such as the browser and email).
How the user likes it used (pay once they've approved) is learned in Switch's brain, never written
into the extension. It has one of two homes:

- **Its own public repo** (`switch-ext-<name>`), for an important, general one, with nothing personal in
  it.
- **A folder in the user's private extensions monorepo**, for a personal one. Names and businesses may be
  there; secrets never are.

## An extension

```ts
import { defineApp, serveStdio, tool } from "switch-ext-kit"
import { Effect, Layer } from "effect"

const app = defineApp({
  name: "hello",
  version: "1",
  tools: [tool("hi", { description: "Says hi.", readOnly: true }, () => Effect.succeed("hi"))],
})

await serveStdio(app, Layer.empty)
```

Its `package.json` carries the manifest:

```json
"extension": {
  "name": "hello",
  "main": "src/main.ts",
  "needs": ["macos"],
  "connections": [{ "provider": "google", "scopes": ["…"], "multiple": true }],
  "widgets": ["face"]
}
```

`template/` is one to copy: a read-only tool, a tool that emits an event, a widget, the manifest
and the checks (`bun run check`: types, UI copy, lint, format).

An extension that isn't TypeScript gives `command` instead of `main` (its `./` paths from the package's
folder), and `"shim": "switchboard"` if it's a Switchboard appendage.

## Widgets

An extension never suggests or makes a space: spaces are the user's. A widget goes on no board until
the user (or the agent, asked) adds it to a space; until then it's in the space's picker.

A widget's `size` says how it sits in a space's grid, in units (one square cell): its `aspect`
(`square`, `wide`, `tall` or `auto`), a `ratio` a wide or tall one keeps (`16 / 9`), its `min`,
`preferred` and `max` `{ cols, rows }`, whether it `grows` past preferred, and what it is with
nothing to show (`empty`: a single `line`, the default, or `hide`).

### Catalogs

A widget is A2UI 1.0, drawn by every client in Switch's look, from two catalogs a component can mix
(a component names its catalog with `catalogId` when it isn't its surface's):

- **A2UI's basic catalog** (`BASIC_CATALOG`, `BASIC_PARTS`): `Text` (Markdown; a `#` heading is a
  section's heading; `variant: "caption"` is supporting words), `Image`, `Icon`, `Row`, `Column`,
  `List`, `Card`, `Tabs`, `Modal`, `Divider`, `Button`, `TextField`, `CheckBox`, `ChoicePicker`,
  `Slider`, `DateTimeInput`, `Video`, `AudioPlayer`.
- **Switch's catalog** (`SWITCH_CATALOG`, `SWITCH_PARTS`, its types in `SwitchParts`): the house
  parts `Line`, `Slot`, `Field`, `Title`, `Row`, `Pick`, `Feed`, `Gallery` (`images: [{ url, description? }]`, a row that scrolls sideways),
  `Check`, `Entry`, `Playing` (what's playing: art, title, who by, back, play/pause and next keys
  calling its tools, a rule running while it plays; paused, one quiet line), and charts that
  take plain data: `BarChart` (grouped or `stacked`, `horizontal`), `LineChart`, `AreaChart`,
  `Sparkline`, `DonutChart`, `ScatterChart`, `Histogram`, `CalendarHeatmap` and `Meter`.

```ts
{ id: "sales", component: "BarChart", labels: ["Mon", "Tue", "Wed"],
  series: [{ name: "Orders", values: [12, 19, 7] }], prefix: "$" }
```

A property can be bound to the widget's data (its tool's result): `series: { "@path": "/series" }`.
`McpApp` (`mcpApp`) is for drawing neither catalog can.

## UI copy

`ui-captions [--allow <file>] [path…]`, a bin, fails on UI copy that narrates: a caption, hint or
empty-state line saying what the app does or how it works, first person, a tooltip past one word,
a placeholder past two, or a dimmed state word or age beside a name. It reads TSX (JSX text, copy
attributes, the ink from classes), A2UI `text`/`label` properties in TypeScript, and Swift. Its
allowlist (`ui-captions.allow`: a path, a tab, words from the string) is for real information only,
such as a permission that's off. An extension runs it in its check, as the template does.

## Its state

Its host runs it in a folder of its own, its working directory, and moves that folder with it to
another machine. Everything it keeps goes there:
- **Events it emits** wait in an outbox there (`events.db`, `serveStdio`'s) until the core acknowledges
  each one (`ACK`), and go again on the next `events/stream` of their type: a core restart loses
  none. The core keeps an event once however often it comes, by its id; give one an `id` that's stable
  for what happened when emitting it again could happen.
- **Its own records** in its log (below).
- **Any other file** written whole with `writeFileAtomic` (to a temp file, then renamed), never in
  place.

The brain's events an extension follows (`switch/follow`, `{ types, after? }`) come as `switch/event`
notifications, each with its `seq`; following again `after` the last one handled misses none.

## Its own log

`Log.layer({ path, events, projections, commands })` keeps an extension's events on its own SQLite file,
with read models over them (`defineCommand`, `on`, `Projection`): `dispatch` a command, `read` the
projections, follow `changes`.

## Models

An extension holds no model keys. `Models.layer` asks the host that runs it, over MCP, which answers
with the user's profile: `decide(input, questions, role?)` picks among choices with
probabilities, `complete(role, system, prompt)` writes text. The host declares the
`ax.switch/models` client extension and answers `models/decide` and `models/complete`; without
one, each call fails with `ModelError`.

## Action items

`Asks` (provided by `Models.layer`) puts an item in the user's queue through the host:
`open({ title, body, kind?, options?, drafts?, attachments?, space?, answerTo? })` and
`close(id, status)`. The host declares `ax.switch/asks` and answers `asks/open` and
`asks/close`. `answerTo` names one of the extension's tools (make it `appOnly`), called once the item
closes with `{ item, status, answer }`.

A sealed ask takes a secret without it entering the brain, a chat or a model's context: make a
one-time key with `sealedKey()` (`switch-ext-kit/sealed`), open the ask with `kind: "sealed"`,
`sealed: { key, use }` and `answerTo`, and keep `secretKey`. The user's client seals what they type
to `key` (HPKE, RFC 9180: X25519, HKDF-SHA256, AES-256-GCM, bound to the item's id and `use`); the
core hands the sealed bytes only to `answerTo`, as `{ item, use, enc, ct }`, and records only that
it was answered. `openSealed(secretKey, item, use, { enc, ct })` gives the secret back.

Switch installs it from a git URL or package name: `extensions_install`, or Extensions in the desktop. A
monorepo folder is installed at a commit from the core machine's `~/.switch/extensions.json`
(`{ "source": "github:<owner>/<repo>#<commit>", "path": "<folder>" }`), packed from that folder.

## Progress

A tool tells its caller how it's going with `Progress` (an Effect reference): `yield* (yield*
Progress)("Ringing")`, sent as MCP's `notifications/progress` when the call asked with a
`progressToken`, else nothing.

## The host

`Host` (provided by `Models.layer`) is the rest an extension asks of the core: `call(name, args)`
another extension's tool (named in `reaches.calls`), `accounts(provider)` and `token(provider,
account)` for a connection it needs, `request` for anything else, and `follow(types, handle)` the
brain's events (named in `reaches.follows`): each handled once, in order, resuming after the last
one handled (`follow.json` in its folder) on every new client.

## Ported appendages

An extension ported from a Switchboard appendage emits what the shim made of its events:
`defineRecord("<extension>.<name>", { kind, stream })` is a version 1 type whose payload is the
record (`kind`, `stream`, `data` and the envelope), and `.record(data, { id, stream, about, refs,
importance, sender, message, eventId, at })` one occurrence, its id the record's own. Its state stays
where it was, `home/` in its folder (the shim's `SB_HOME`).

## Session connections

A session need declares `session: { signIn: "sign_in", status: "connection_status" }`. Both tools take
`{ account? }`. `signIn` prepares the exact browser session and returns `{ view: { app, name, input } }`
for a widget, or `{ url }` for a client link. `status` only reads the real session and returns
`{ accounts: [{ account }] }`, empty when signed out. Switch verifies it before closing connection asks.
Never infer a signed-in account from a checkout that permits guests.
