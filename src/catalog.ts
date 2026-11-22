// Switch's catalog (`SWITCH_CATALOG`): the house parts every client draws in Switch's look, beside
// A2UI's basic catalog, which clients draw in the same look. An extension's widget and a view the
// agent makes use either; a component names its catalog with `catalogId` when it isn't the
// surface's own. Each part is declared here, so what's written and what's drawn are one thing.
//
// A property that's `Bound` takes its value, or a binding to the surface's data model
// (`{ "@path": "/rows" }`), or a function call (`{ "@call": "formatString", "args": … }`).
import { Schema } from "effect"

/** A value from the surface's data model, by JSON Pointer. */
export interface DataBinding {
  readonly "@path": string
}

/** A value a catalog function works out. */
export interface FunctionCall {
  readonly "@call": string
  readonly args?: Readonly<Record<string, unknown>>
}

/** A value, or where it comes from. */
export type Bound<T> = T | DataBinding | FunctionCall

/** Children by id, or one component repeated for each item of a list in the data model. */
export type ChildList = readonly string[] | { readonly componentId: string; readonly path: string }

const binding = Schema.Struct({ "@path": Schema.String })
const call = Schema.Struct({
  "@call": Schema.String,
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
const bound = <S extends Schema.Top>(s: S) => Schema.Union([s, binding, call])
const text = bound(Schema.String)
const flag = bound(Schema.Boolean)
const number = bound(Schema.Finite)
const children = Schema.Union([
  Schema.Array(Schema.String),
  Schema.Struct({ componentId: Schema.String, path: Schema.String }),
])
const px = Schema.Finite.check(Schema.isGreaterThan(0))

// ---- Lines and rows

/** One line: its mark, its name, and a time that runs while it does (`left` down, `elapsed` up). */
export interface Line {
  readonly label: Bound<string>
  readonly running?: Bound<boolean>
  readonly ringing?: Bound<boolean>
  /** Ms left, counting down while it runs. */
  readonly left?: Bound<number>
  /** Ms gone, counting up while it runs. */
  readonly elapsed?: Bound<number>
  /** When the times were read, in ms. */
  readonly asOf?: Bound<number>
}

/** A line in time: when, its live marks, what. */
export interface Slot {
  readonly time: Bound<string>
  readonly title: Bound<string>
  readonly running?: Bound<boolean>
  readonly needsYou?: Bound<boolean>
  readonly conflict?: Bound<boolean>
}

/** A line of label and value, with a red triangle when it's worth a look. */
export interface Field {
  readonly label: Bound<string>
  readonly value: Bound<string>
  readonly alert?: Bound<boolean>
}

/** What a card is about, in reading size, with a hand when it needs the user. */
export interface Title {
  readonly label: Bound<string>
  readonly needsYou?: Bound<boolean>
}

/**
 * A line with its live mark, name and what's under it, figures at its end, a progress rule along
 * its foot and a countdown to `endsAt`; its children under it, one equal column each.
 */
export interface Row {
  readonly label: Bound<string>
  /** `running`, `needsYou`, `stop` or `warn`. */
  readonly mark?: Bound<string>
  readonly detail?: Bound<string>
  /** The detail is what's wrong. */
  readonly alert?: Bound<boolean>
  readonly values?: Bound<readonly string[]>
  /** 0 to 100, or null for none. */
  readonly progress?: Bound<number | null>
  /** When it ends, in ms, or null. */
  readonly endsAt?: Bound<number | null>
  readonly children?: ChildList
  /** A page the whole row opens in the browser. */
  readonly url?: Bound<string>
}

/** A group of choices a Pick offers: words, or RRGGBB colors as swatches. */
export interface Choices {
  readonly key: string
  readonly choices: readonly string[]
  readonly swatches?: boolean
}

/** A key with its swatch and label, opening choices; Set calls `action` with `args` and the picks. */
export interface Pick {
  readonly label: Bound<string>
  readonly swatch?: Bound<string>
  /** In use now. */
  readonly strong?: Bound<boolean>
  readonly title?: Bound<string>
  readonly groups: readonly Choices[]
  /** What each group holds now, by key. */
  readonly current?: Bound<Readonly<Record<string, unknown>>>
  readonly action: string
  readonly args?: Bound<Readonly<Record<string, unknown>>>
}

/** A live picture, a frame from `action` with `args` every `every` ms, edge to edge at `ratio`. */
export interface Feed {
  readonly action: string
  readonly args?: Bound<Readonly<Record<string, unknown>>>
  readonly every?: number
  /** Width over height: 16 / 9. */
  readonly ratio?: number
}

/** A line that ticks off: its ring calls `action` with `args`. */
export interface Check {
  readonly label: Bound<string>
  readonly detail?: Bound<string>
  readonly done?: Bound<boolean>
  readonly action: string
  readonly args?: Bound<Readonly<Record<string, unknown>>>
}

/** A line to write in: Enter calls `action` with `args` and the words under `field`. */
export interface Entry {
  readonly placeholder?: Bound<string>
  readonly action: string
  readonly args?: Bound<Readonly<Record<string, unknown>>>
  readonly field: string
}

// ---- Charts: plain data in, drawn in a fixed palette (never cycled) in the house look

/** How a chart's figures read: a prefix and a suffix round each ("$", "%", " kg"). */
export interface Figures {
  readonly prefix?: string
  readonly suffix?: string
}

/** A named series: a value for each label, or null for none. */
export interface Series {
  readonly name: string
  readonly values: readonly (number | null)[]
}

/** Bars for each label: a series each, side by side or stacked; columns, or rows when horizontal. */
export interface BarChart extends Figures {
  readonly labels: Bound<readonly string[]>
  /** One to eight. */
  readonly series: Bound<readonly Series[]>
  readonly stacked?: boolean
  readonly horizontal?: boolean
  /** Px, else its own. */
  readonly height?: number
}

/** A line per series over labels evenly spaced along the bottom (days, months). */
export interface LineChart extends Figures {
  readonly labels: Bound<readonly string[]>
  /** One to eight. */
  readonly series: Bound<readonly Series[]>
  readonly height?: number
}

/** A line chart filled under each line, or stacked. */
export interface AreaChart extends LineChart {
  readonly stacked?: boolean
}

/** A trend as one small line, its latest point marked: a line's height unless `height`. */
export interface Sparkline {
  readonly values: Bound<readonly number[]>
  readonly height?: number
}

export interface Slice {
  readonly label: string
  readonly value: number
}

/** Parts of a whole, round a ring with the total in it; six slices at most read at a glance. */
export interface DonutChart extends Figures {
  readonly slices: Bound<readonly Slice[]>
}

export interface Points {
  readonly name: string
  /** `[x, y]` each. */
  readonly points: readonly (readonly [number, number])[]
}

/** Points by two measures; three series at most stay apart. */
export interface ScatterChart {
  readonly series: Bound<readonly Points[]>
  readonly xLabel?: string
  readonly yLabel?: string
  readonly height?: number
}

/** How raw values spread, counted into `bins` (else its own) bars. */
export interface Histogram extends Figures {
  readonly values: Bound<readonly number[]>
  readonly bins?: number
  readonly height?: number
}

export interface Day {
  /** `YYYY-MM-DD`. */
  readonly date: string
  readonly value: number
}

/** A value per day, as weeks of squares, darker for more. */
export interface CalendarHeatmap extends Figures {
  readonly days: Bound<readonly Day[]>
}

/** How full something is: a line with its label, a track filled to `value` of `max` (100), and the figure. */
export interface Meter extends Figures {
  readonly label?: Bound<string>
  readonly value: Bound<number>
  readonly max?: number
}

/** Every part of Switch's catalog, by name. */
export interface SwitchParts {
  readonly Line: Line
  readonly Slot: Slot
  readonly Field: Field
  readonly Title: Title
  readonly Row: Row
  readonly Pick: Pick
  readonly Feed: Feed
  readonly Check: Check
  readonly Entry: Entry
  readonly BarChart: BarChart
  readonly LineChart: LineChart
  readonly AreaChart: AreaChart
  readonly Sparkline: Sparkline
  readonly DonutChart: DonutChart
  readonly ScatterChart: ScatterChart
  readonly Histogram: Histogram
  readonly CalendarHeatmap: CalendarHeatmap
  readonly Meter: Meter
}

/** A component of Switch's catalog: its id, its part and the part's properties. */
export type SwitchComponent = {
  readonly [K in keyof SwitchParts]: { readonly id: string; readonly component: K } & SwitchParts[K]
}[keyof SwitchParts]

const action = {
  action: Schema.String,
  args: Schema.optionalKey(bound(Schema.Record(Schema.String, Schema.Unknown))),
}
const figures = {
  prefix: Schema.optionalKey(Schema.String),
  suffix: Schema.optionalKey(Schema.String),
}
const series = bound(
  Schema.Array(
    Schema.Struct({ name: Schema.String, values: Schema.Array(Schema.NullOr(Schema.Finite)) }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
)
const lines = {
  ...figures,
  labels: bound(Schema.Array(Schema.String)),
  series,
  height: Schema.optionalKey(px),
}

/** Each part's properties, to check a component by. */
export const SWITCH_PARTS: { readonly [K in keyof SwitchParts]: Schema.Codec<SwitchParts[K]> } = {
  Line: Schema.Struct({
    label: text,
    running: Schema.optionalKey(flag),
    ringing: Schema.optionalKey(flag),
    left: Schema.optionalKey(number),
    elapsed: Schema.optionalKey(number),
    asOf: Schema.optionalKey(number),
  }),
  Slot: Schema.Struct({
    time: text,
    title: text,
    running: Schema.optionalKey(flag),
    needsYou: Schema.optionalKey(flag),
    conflict: Schema.optionalKey(flag),
  }),
  Field: Schema.Struct({ label: text, value: text, alert: Schema.optionalKey(flag) }),
  Title: Schema.Struct({ label: text, needsYou: Schema.optionalKey(flag) }),
  Row: Schema.Struct({
    label: text,
    mark: Schema.optionalKey(text),
    detail: Schema.optionalKey(text),
    alert: Schema.optionalKey(flag),
    values: Schema.optionalKey(bound(Schema.Array(Schema.String))),
    progress: Schema.optionalKey(bound(Schema.NullOr(Schema.Finite))),
    endsAt: Schema.optionalKey(bound(Schema.NullOr(Schema.Finite))),
    children: Schema.optionalKey(children),
    url: Schema.optionalKey(text),
  }),
  Pick: Schema.Struct({
    label: text,
    swatch: Schema.optionalKey(text),
    strong: Schema.optionalKey(flag),
    title: Schema.optionalKey(text),
    groups: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        choices: Schema.Array(Schema.String),
        swatches: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    current: Schema.optionalKey(bound(Schema.Record(Schema.String, Schema.Unknown))),
    ...action,
  }),
  Feed: Schema.Struct({
    ...action,
    every: Schema.optionalKey(px),
    ratio: Schema.optionalKey(px),
  }),
  Check: Schema.Struct({
    label: text,
    detail: Schema.optionalKey(text),
    done: Schema.optionalKey(flag),
    ...action,
  }),
  Entry: Schema.Struct({ placeholder: Schema.optionalKey(text), field: Schema.String, ...action }),
  BarChart: Schema.Struct({
    ...lines,
    stacked: Schema.optionalKey(Schema.Boolean),
    horizontal: Schema.optionalKey(Schema.Boolean),
  }),
  LineChart: Schema.Struct(lines),
  AreaChart: Schema.Struct({ ...lines, stacked: Schema.optionalKey(Schema.Boolean) }),
  Sparkline: Schema.Struct({
    values: bound(Schema.Array(Schema.Finite)),
    height: Schema.optionalKey(px),
  }),
  DonutChart: Schema.Struct({
    ...figures,
    slices: bound(Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.Finite }))),
  }),
  ScatterChart: Schema.Struct({
    series: bound(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          points: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite])),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
    ),
    xLabel: Schema.optionalKey(Schema.String),
    yLabel: Schema.optionalKey(Schema.String),
    height: Schema.optionalKey(px),
  }),
  Histogram: Schema.Struct({
    ...figures,
    values: bound(Schema.Array(Schema.Finite)),
    bins: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    height: Schema.optionalKey(px),
  }),
  CalendarHeatmap: Schema.Struct({
    ...figures,
    days: bound(
      Schema.Array(
        Schema.Struct({
          date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
          value: Schema.Finite,
        }),
      ),
    ),
  }),
  Meter: Schema.Struct({
    ...figures,
    label: Schema.optionalKey(text),
    value: number,
    max: Schema.optionalKey(px),
  }),
}

/** The parts of A2UI's basic catalog (`BASIC_CATALOG`), which clients draw in Switch's look. */
export const BASIC_PARTS: readonly string[] = [
  "Text",
  "Image",
  "Icon",
  "Video",
  "AudioPlayer",
  "Row",
  "Column",
  "List",
  "Card",
  "Tabs",
  "Modal",
  "Divider",
  "Button",
  "TextField",
  "CheckBox",
  "ChoicePicker",
  "Slider",
  "DateTimeInput",
]
