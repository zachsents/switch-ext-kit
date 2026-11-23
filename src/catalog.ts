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
  /** The catalog whose function it is; none, the surface's catalog. */
  readonly catalogId?: string
}

/** A value, or where it comes from. */
export type Bound<T> = T | DataBinding | FunctionCall

/** Children by id, or one component repeated for each item of a list in the data model. */
export type ChildList = readonly string[] | { readonly componentId: string; readonly path: string }

const binding = Schema.Struct({ "@path": Schema.String })
const call = Schema.Struct({
  "@call": Schema.String,
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  catalogId: Schema.optionalKey(Schema.String),
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

/** A picture of a Gallery: its link, and what it shows. */
export interface GalleryImage {
  readonly url: string
  readonly description?: string
}

/** Several pictures as a row that scrolls sideways, each at one height and its own width, opening on a click. */
export interface Gallery {
  readonly images: Bound<readonly GalleryImage[]>
}

/** A line that ticks off: its ring calls `action` with `args`. */
export interface Check {
  readonly label: Bound<string>
  readonly detail?: Bound<string>
  readonly done?: Bound<boolean>
  readonly action: string
  readonly args?: Bound<Readonly<Record<string, unknown>>>
}

/**
 * What's playing: its art, title and who by, keys back, play or pause, and next, each calling its
 * extension's tool, and a rule along its foot that runs while it plays. Paused, one quiet line:
 * its title and the play key.
 */
export interface Playing {
  readonly title: Bound<string>
  readonly by?: Bound<string>
  /** The art's link. */
  readonly art?: Bound<string>
  readonly playing: Bound<boolean>
  /** Ms in, as of `asOf`. */
  readonly at?: Bound<number>
  /** Ms long. */
  readonly length?: Bound<number>
  /** When `at` was read, in ms. */
  readonly asOf?: Bound<number>
  /** The tools the keys call, with no arguments. */
  readonly back: string
  readonly toggle: string
  readonly next: string
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
  readonly Gallery: Gallery
  readonly Check: Check
  readonly Entry: Entry
  readonly Playing: Playing
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
  Gallery: Schema.Struct({
    images: bound(
      Schema.Array(
        Schema.Struct({ url: Schema.String, description: Schema.optionalKey(Schema.String) }),
      ),
    ),
  }),
  Check: Schema.Struct({
    label: text,
    detail: Schema.optionalKey(text),
    done: Schema.optionalKey(flag),
    ...action,
  }),
  Entry: Schema.Struct({ placeholder: Schema.optionalKey(text), field: Schema.String, ...action }),
  Playing: Schema.Struct({
    title: text,
    by: Schema.optionalKey(text),
    art: Schema.optionalKey(text),
    playing: flag,
    at: Schema.optionalKey(number),
    length: Schema.optionalKey(number),
    asOf: Schema.optionalKey(number),
    back: Schema.String,
    toggle: Schema.String,
    next: Schema.String,
  }),
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

// ---- A2UI's basic catalog (`BASIC_CATALOG`), v1.0: its parts as the spec declares them

/** The basic catalog's icons by name. */
export const ICONS: readonly string[] = [
  "accountCircle",
  "add",
  "arrowBack",
  "arrowForward",
  "attachFile",
  "calendarToday",
  "call",
  "camera",
  "check",
  "close",
  "delete",
  "download",
  "edit",
  "event",
  "error",
  "fastForward",
  "favorite",
  "favoriteOff",
  "folder",
  "help",
  "home",
  "info",
  "locationOn",
  "lock",
  "lockOpen",
  "mail",
  "menu",
  "moreVert",
  "moreHoriz",
  "notificationsOff",
  "notifications",
  "pause",
  "payment",
  "person",
  "phone",
  "photo",
  "play",
  "print",
  "refresh",
  "rewind",
  "search",
  "send",
  "settings",
  "share",
  "shoppingCart",
  "skipNext",
  "skipPrevious",
  "star",
  "starHalf",
  "starOff",
  "stop",
  "upload",
  "visibility",
  "visibilityOff",
  "volumeDown",
  "volumeMute",
  "volumeOff",
  "volumeUp",
  "warning",
]
interface Weighted {
  readonly weight?: number
}
/** What a Button does: an event the host handles, or a catalog function. */
export type Action =
  | {
      readonly event: {
        readonly name: string
        readonly userMessage?: Bound<string>
        readonly context?: Readonly<Record<string, unknown>>
      }
    }
  | { readonly functionCall: FunctionCall }
/** A check an input runs: a condition, and what's wrong when it fails. */
export interface CheckRule {
  readonly condition: DataBinding | FunctionCall
  readonly message?: string
}
type Checked = Weighted & { readonly checks?: readonly CheckRule[] }
type Justify =
  | "start"
  | "center"
  | "end"
  | "spaceBetween"
  | "spaceAround"
  | "spaceEvenly"
  | "stretch"
type Align = "start" | "center" | "end" | "stretch"

/** Every part of A2UI's basic catalog, by name. */
export interface BasicParts {
  readonly Text: Weighted & { readonly text: Bound<string>; readonly variant?: "caption" | "body" }
  readonly Image: Weighted & {
    readonly url: Bound<string>
    readonly description?: Bound<string>
    readonly fit?: "contain" | "cover" | "fill" | "none" | "scaleDown"
    readonly variant?:
      | "icon"
      | "avatar"
      | "smallFeature"
      | "mediumFeature"
      | "largeFeature"
      | "header"
  }
  readonly Icon: Weighted & {
    readonly name: string | { readonly svgPath: Bound<string> } | DataBinding
  }
  readonly Video: Weighted & { readonly url: Bound<string>; readonly posterUrl?: Bound<string> }
  readonly AudioPlayer: Weighted & {
    readonly url: Bound<string>
    readonly description?: Bound<string>
  }
  readonly Row: Weighted & {
    readonly children: ChildList
    readonly justify?: Justify
    readonly align?: Align
  }
  readonly Column: Weighted & {
    readonly children: ChildList
    readonly justify?: Justify
    readonly align?: Align
  }
  readonly List: Weighted & {
    readonly children: ChildList
    readonly direction?: "vertical" | "horizontal"
    readonly align?: Align
  }
  readonly Card: Weighted & { readonly child: string }
  readonly Tabs: Weighted & {
    readonly tabs: readonly { readonly title: Bound<string>; readonly child: string }[]
  }
  readonly Modal: Weighted & { readonly trigger: string; readonly content: string }
  readonly Divider: Weighted & { readonly axis?: "horizontal" | "vertical" }
  readonly Button: Checked & {
    readonly child: string
    readonly variant?: "default" | "primary" | "borderless"
    readonly action: Action
  }
  readonly TextField: Checked & {
    readonly label: Bound<string>
    readonly value?: Bound<string>
    readonly placeholder?: Bound<string>
    readonly variant?: "longText" | "number" | "shortText" | "obscured"
  }
  readonly CheckBox: Checked & { readonly label: Bound<string>; readonly value: Bound<boolean> }
  readonly ChoicePicker: Checked & {
    readonly label?: Bound<string>
    readonly variant?: "multipleSelection" | "mutuallyExclusive"
    readonly options: readonly { readonly label: Bound<string>; readonly value: string }[]
    readonly value: Bound<readonly string[]>
    readonly displayStyle?: "checkbox" | "chips"
    readonly filterable?: boolean
  }
  readonly Slider: Checked & {
    readonly label?: Bound<string>
    readonly min?: number
    readonly max: number
    readonly value: Bound<number>
    readonly steps?: number
  }
  readonly DateTimeInput: Checked & {
    readonly value: Bound<string>
    readonly enableDate?: boolean
    readonly enableTime?: boolean
    readonly min?: Bound<string>
    readonly max?: Bound<string>
    readonly label?: Bound<string>
  }
}

const weighted = { weight: Schema.optionalKey(Schema.Finite) }
const checked = {
  ...weighted,
  checks: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        condition: Schema.Union([binding, call]),
        message: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
}
const justify = Schema.optionalKey(
  Schema.Literals([
    "start",
    "center",
    "end",
    "spaceBetween",
    "spaceAround",
    "spaceEvenly",
    "stretch",
  ]),
)
const align = Schema.optionalKey(Schema.Literals(["start", "center", "end", "stretch"]))
const textList = bound(Schema.Array(Schema.String))

/** Each basic part's properties, to check a component by. */
export const BASIC_PARTS: { readonly [K in keyof BasicParts]: Schema.Codec<BasicParts[K]> } = {
  Text: Schema.Struct({
    ...weighted,
    text,
    variant: Schema.optionalKey(Schema.Literals(["caption", "body"])),
  }),
  Image: Schema.Struct({
    ...weighted,
    url: text,
    description: Schema.optionalKey(text),
    fit: Schema.optionalKey(Schema.Literals(["contain", "cover", "fill", "none", "scaleDown"])),
    variant: Schema.optionalKey(
      Schema.Literals([
        "icon",
        "avatar",
        "smallFeature",
        "mediumFeature",
        "largeFeature",
        "header",
      ]),
    ),
  }),
  Icon: Schema.Struct({
    ...weighted,
    name: Schema.Union([
      Schema.String.check(Schema.makeFilter((n: string) => ICONS.includes(n) || `No icon ${n}`)),
      Schema.Struct({ svgPath: text }),
      binding,
    ]),
  }),
  Video: Schema.Struct({ ...weighted, url: text, posterUrl: Schema.optionalKey(text) }),
  AudioPlayer: Schema.Struct({ ...weighted, url: text, description: Schema.optionalKey(text) }),
  Row: Schema.Struct({ ...weighted, children, justify, align }),
  Column: Schema.Struct({ ...weighted, children, justify, align }),
  List: Schema.Struct({
    ...weighted,
    children,
    direction: Schema.optionalKey(Schema.Literals(["vertical", "horizontal"])),
    align,
  }),
  Card: Schema.Struct({ ...weighted, child: Schema.String }),
  Tabs: Schema.Struct({
    ...weighted,
    tabs: Schema.Array(Schema.Struct({ title: text, child: Schema.String })).check(
      Schema.isMinLength(1),
    ),
  }),
  Modal: Schema.Struct({ ...weighted, trigger: Schema.String, content: Schema.String }),
  Divider: Schema.Struct({
    ...weighted,
    axis: Schema.optionalKey(Schema.Literals(["horizontal", "vertical"])),
  }),
  Button: Schema.Struct({
    ...checked,
    child: Schema.String,
    variant: Schema.optionalKey(Schema.Literals(["default", "primary", "borderless"])),
    action: Schema.Union([
      Schema.Struct({
        event: Schema.Struct({
          name: Schema.String,
          userMessage: Schema.optionalKey(text),
          context: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      }),
      Schema.Struct({ functionCall: call }),
    ]),
  }),
  TextField: Schema.Struct({
    ...checked,
    label: text,
    value: Schema.optionalKey(text),
    placeholder: Schema.optionalKey(text),
    variant: Schema.optionalKey(Schema.Literals(["longText", "number", "shortText", "obscured"])),
  }),
  CheckBox: Schema.Struct({ ...checked, label: text, value: flag }),
  ChoicePicker: Schema.Struct({
    ...checked,
    label: Schema.optionalKey(text),
    variant: Schema.optionalKey(Schema.Literals(["multipleSelection", "mutuallyExclusive"])),
    options: Schema.Array(Schema.Struct({ label: text, value: Schema.String })),
    value: textList,
    displayStyle: Schema.optionalKey(Schema.Literals(["checkbox", "chips"])),
    filterable: Schema.optionalKey(Schema.Boolean),
  }),
  Slider: Schema.Struct({
    ...checked,
    label: Schema.optionalKey(text),
    min: Schema.optionalKey(Schema.Finite),
    max: Schema.Finite,
    value: number,
    steps: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
  DateTimeInput: Schema.Struct({
    ...checked,
    value: text,
    enableDate: Schema.optionalKey(Schema.Boolean),
    enableTime: Schema.optionalKey(Schema.Boolean),
    min: Schema.optionalKey(text),
    max: Schema.optionalKey(text),
    label: Schema.optionalKey(text),
  }),
}
