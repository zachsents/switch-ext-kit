// The user's own laptop, the machine they work at: nothing heavy or interruptive of the agent's
// runs there while another machine can do it, even while they've stepped away. Which machine that
// is, is data: its host lists `personal` in what it provides, and an extension sees it in
// SWITCH_PROVIDES. Ported from Switchboard's laptop guard (sb guard, the macOS appendage's
// personal.rs): it reads what a command line runs, with the variables it sets followed, into `sh
// -c`, `eval` and the scripts it runs, and stand-ins first on PATH refuse what a script runs deeper
// down.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { simpleCommands } from "./shell.ts"

export { simpleCommands } from "./shell.ts"

/** What a machine provides when it's the user's own laptop. */
export const PERSONAL = "personal"

/** The argument, and the variable leading a shell command, that carries the user's asking. */
export const PERSON_ASKED = "person_asked"
const ASKED_VAR = "PERSON_ASKED"
const ASKED_MIN = 8

/** What this extension's machine provides, as its host said. */
export const provides = (): readonly string[] =>
  (process.env.SWITCH_PROVIDES ?? "").split(",").filter((p) => p !== "")

/** Whether this extension runs on the user's own laptop. */
export const personal = (): boolean => provides().includes(PERSONAL)

/** Whether `said` is the user's words, enough to be theirs. */
export const asked = (said: unknown): boolean =>
  typeof said === "string" && said.trim().length >= ASKED_MIN

/** Programs that make a machine hot or slow, by the name they're run by. */
const HEAVY = new Set([
  "blender",
  "ffmpeg",
  "xcodebuild",
  "simctl",
  "bambustudio",
  "orcaslicer",
  "prusaslicer",
  "remotion",
])
/** What `cargo` or `swift` does when it builds. */
const BUILDS = new Set(["build", "test", "clippy", "check", "run", "bench", "nextest", "install"])
const WRAPPERS = new Set([
  "sudo",
  "nice",
  "env",
  "time",
  "nohup",
  "exec",
  "caffeinate",
  "xcrun",
  "taskpolicy",
  "timeout",
  "command",
  "arch",
  "noglob",
])
const INTO = new Set(["sh", "zsh", "bash", "dash", "open"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash"])
/** Flags that only ask a program what it is or can do. */
const LIGHT = new Set([
  "--version",
  "-version",
  "--help",
  "-help",
  "-h",
  "--list",
  "-list",
  "-showsdks",
])
/** What `xcrun simctl` does that boots nothing. */
const SIMCTL_LIGHT = new Set(["list", "shutdown", "delete", "help", "getenv", "runtime"])
const INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "ruby",
  "perl",
  "osascript",
  "uv",
])
const DEPTH = 3
const SCRIPT_BYTES = 512 * 1024

const nameOf = (word: string) => word.split("/").at(-1) ?? word

const isOption = (w: string) => w.startsWith("-") || w.startsWith("+")
const isNumber = (w: string) => w !== "" && !Number.isNaN(Number(w))

/** A shell assignment's name and value (`B=/Applications/…`). */
const assignment = (word: string): readonly [string, string] | null => {
  const at = word.indexOf("=")
  if (at <= 0) {
    return null
  }
  const name = word.slice(0, at)
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ? [name, word.slice(at + 1)] : null
}

const substitute = (word: string, vars: ReadonlyMap<string, string>) =>
  word.includes("$")
    ? word.replaceAll(
        /\$\{(?<braced>[A-Za-z_][A-Za-z0-9_]*)\}|\$(?<bare>[A-Za-z_][A-Za-z0-9_]*)/gu,
        (all, a: string | undefined, b: string | undefined) => vars.get(a ?? b ?? "") ?? all,
      )
    : word

/** The heavy program one command runs, past assignments, options and wrappers, into shells. */
const heavyRun = (words: readonly string[]): string | null => {
  // `command -v ffmpeg` only asks where it is.
  for (let i = 0; i + 1 < words.length; i += 1) {
    if (nameOf(words[i] ?? "") === "command" && (words[i + 1] === "-v" || words[i + 1] === "-V")) {
      return null
    }
  }
  const rest = words.filter((w) => !isOption(w) && !isNumber(w))
  let at = 0
  while (at < rest.length && assignment(rest[at] ?? "") !== null) {
    at += 1
  }
  for (; at < rest.length; at += 1) {
    const name = nameOf(rest[at] ?? "")
      .toLowerCase()
      .replace(/\.app$/u, "")
    if (HEAVY.has(name)) {
      return name
    }
    if (name === "cargo" || name === "swift") {
      const sub = rest[at + 1] ?? ""
      return BUILDS.has(sub) ? `${name} ${sub}` : null
    }
    if (!WRAPPERS.has(name) && !INTO.has(name)) {
      return null
    }
  }
  return null
}

/** Whether what a heavy program was asked to do is light anyway. */
const light = (found: string, words: readonly string[]) => {
  if (found.startsWith("cargo") || found.startsWith("swift")) {
    return false
  }
  if (found === "simctl") {
    const at = words.findIndex((w) => nameOf(w) === "simctl")
    return SIMCTL_LIGHT.has(words[at + 1] ?? "")
  }
  return words.some((w) => LIGHT.has(w))
}

/** The bodies of a command line's here documents. */
const hereDocuments = (line: string) => {
  const bodies: string[] = []
  for (const found of line.matchAll(/<<-?\s*['"]?(?<delimiter>[A-Za-z_][A-Za-z0-9_]*)['"]?/gu)) {
    const delimiter = found.groups?.delimiter ?? ""
    const after = line.slice((found.index ?? 0) + found[0].length)
    const start = after.indexOf("\n")
    if (start === -1) {
      continue
    }
    const body: string[] = []
    for (const l of after.slice(start + 1).split("\n")) {
      if (l.replace(/^\t+/u, "") === delimiter) {
        break
      }
      body.push(l)
    }
    bodies.push(body.join("\n"))
  }
  return bodies
}

/** The heavy programs a script of another language names as strings. */
const named = (text: string) => {
  const program =
    /["'](?:[^"'\s]*\/)?(?<name>blender|ffmpeg|xcodebuild|bambustudio|orcaslicer|prusaslicer|remotion)(?:\.app)?["'\s]/iu.exec(
      text,
    )
  if (program) {
    return (program.groups?.name ?? "").toLowerCase()
  }
  const cargo =
    /["'](?<p1>cargo|swift)["']\s*,\s*["'](?<s1>build|test|clippy|check|run|bench|nextest|install)["']|["'](?<p2>cargo|swift) (?<s2>build|test|clippy|check|run|bench|nextest|install)\b/u.exec(
      text,
    )
  const g = cargo?.groups
  return g ? `${g.p1 ?? g.p2 ?? "cargo"} ${g.s1 ?? g.s2 ?? "build"}` : null
}

const shebangShell = (text: string) => {
  const first = text.split("\n")[0] ?? ""
  return first.startsWith("#!") && first.split(/[/\s]/u).some((w) => SHELLS.has(w))
}

type Script =
  | { readonly kind: "file"; readonly file: string; readonly shell: boolean | null }
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "stdin" }

/** The script a command runs: what a shell or an interpreter is given, or the command as a path. */
const scriptOf = (words: readonly string[]): Script | null => {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? ""
    const program = nameOf(word)
    if (isOption(word) || isNumber(word) || WRAPPERS.has(program) || assignment(word) !== null) {
      continue
    }
    const rest = words.slice(at + 1)
    if (SHELLS.has(program) || program === "source" || program === ".") {
      const file = rest.find((w) => !w.startsWith("-"))
      return file === undefined ? null : { kind: "file", file, shell: true }
    }
    if (INTERPRETERS.has(program) || program.startsWith("python3.")) {
      const c = rest.findIndex((w) => w === "-c" || w === "-e")
      const code = c === -1 ? undefined : rest[c + 1]
      if (code !== undefined) {
        return { kind: "code", code }
      }
      // `uv run x.py`, `bun run x.ts`: past the subcommand to the file.
      const file = rest.find((w) => !w.startsWith("-") && (w.includes(".") || w.includes("/")))
      return file === undefined ? { kind: "stdin" } : { kind: "file", file, shell: false }
    }
    return word.includes("/") ? { kind: "file", file: word, shell: null } : null
  }
  return null
}

/** Reads a script, if it's a file of a size worth reading. */
export type Reader = (file: string) => string | null

const readLocal: Reader = (file) => {
  try {
    const s = statSync(file)
    return s.isFile() && s.size <= SCRIPT_BYTES ? readFileSync(file, "utf-8") : null
  } catch {
    return null
  }
}

const expand = (p: string, dir: string, home: string) => {
  if (p === "~") {
    return home
  }
  if (p.startsWith("~/")) {
    return path.join(home, p.slice(2))
  }
  return path.resolve(dir, p)
}

interface Walk {
  readonly home: string
  readonly read: Reader
}

const inScript = (
  words: readonly string[],
  dir: string,
  line: string,
  vars: Map<string, string>,
  depth: number,
  w: Walk,
): string | null => {
  const s = scriptOf(words)
  if (s === null) {
    return null
  }
  let text = ""
  let said: string | null = null
  let shell = false
  if (s.kind === "code") {
    text = s.code
  } else if (s.kind === "stdin") {
    text = hereDocuments(line).join("\n")
  } else {
    const file = expand(s.file, dir, w.home)
    // Not there yet: the same command line may be writing it, with a here document.
    text = w.read(file) ?? (existsSync(file) ? "" : hereDocuments(line).join("\n"))
    said = s.file
    shell = s.shell ?? shebangShell(text)
  }
  const found = shell ? runs(text, dir, new Map(vars), depth + 1, w) : named(text)
  if (found === null) {
    return null
  }
  return said !== null && !found.includes(", in ") ? `${found}, in ${said}` : found
}

const DECLARE = new Set(["export", "local", "readonly", "declare", "typeset"])

/**
 * Takes a command's assignments into `vars`: alone, they set what later `$NAME`s stand for;
 * leading, they're its environment. The words left to run, none for a declaration.
 */
const assign = (all: readonly string[], vars: Map<string, string>) => {
  let at = 0
  for (let a = assignment(all[at] ?? ""); a !== null; a = assignment(all[at] ?? "")) {
    vars.set(a[0], substitute(a[1], vars))
    at += 1
  }
  if (DECLARE.has(all[at] ?? "")) {
    for (const word of all.slice(at + 1)) {
      const a = assignment(word)
      if (a !== null) {
        vars.set(a[0], substitute(a[1], vars))
      }
    }
    return []
  }
  return all.slice(at).map((x) => substitute(x, vars))
}

/** What a shell's `-c` runs, among its own options before what it's given. */
const dashC = (rest: readonly string[]) => {
  const options = rest.findIndex((x) => !isOption(x))
  const own = options === -1 ? rest : rest.slice(0, options)
  const at = own.findIndex(
    (x) => x === "-c" || (!x.startsWith("--") && x.startsWith("-") && x.endsWith("c")),
  )
  return at === -1 ? null : (rest[at + 1] ?? "")
}

interface Here {
  dir: string
  readonly line: string
  readonly vars: Map<string, string>
  readonly depth: number
  readonly w: Walk
}

/** What one command runs that's heavy, following it into shells, eval and scripts. */
const runOne = (words: readonly string[], h: Here): string | null => {
  const [program = "", ...rest] = words
  const name = nameOf(program)
  if (name === "cd" || name === "pushd") {
    const to = rest.find((x) => !x.startsWith("-"))
    if (to !== undefined) {
      h.dir = expand(to, h.dir, h.w.home)
    } else if (rest.length === 0) {
      h.dir = h.w.home
    }
    return null
  }
  const inner = SHELLS.has(name) ? dashC(rest) : null
  if (inner !== null) {
    return runs(inner, h.dir, h.vars, h.depth, h.w)
  }
  if (name === "eval") {
    return runs(rest.join(" "), h.dir, h.vars, h.depth, h.w)
  }
  const found = heavyRun(words)
  if (found !== null) {
    return light(found, words) ? null : found
  }
  return h.depth < DEPTH ? inScript(words, h.dir, h.line, h.vars, h.depth, h.w) : null
}

const runs = (
  line: string,
  dir: string,
  vars: Map<string, string>,
  depth: number,
  w: Walk,
): string | null => {
  const h: Here = { dir, line, vars, depth, w }
  for (const all of simpleCommands(line)) {
    const words = assign(all, vars)
    const found = words.length > 0 ? runOne(words, h) : null
    if (found !== null) {
      return found
    }
  }
  return null
}

/** The words of a leading `PERSON_ASKED='…'`: the user asked for exactly this, here. */
export const personAsked = (command: string): string | null => {
  for (const words of simpleCommands(command)) {
    for (const word of words) {
      const a = assignment(word)
      if (a !== null && a[0] === ASKED_VAR && asked(a[1])) {
        return a[1]
      }
    }
  }
  return null
}

/**
 * The heavy work a shell command line runs, as a phrase ("blender", "cargo test, in build.sh"), or
 * null: builds and tests, Blender, encoders, simulators, slicers. Null too when it carries the
 * user's asking (`PERSON_ASKED`).
 */
export const heavy = (
  command: string,
  options: { readonly cwd?: string; readonly home?: string; readonly read?: Reader } = {},
): string | null => {
  if (personAsked(command) !== null) {
    return null
  }
  const home = options.home ?? homedir()
  return runs(command, options.cwd ?? home, new Map(), 0, { home, read: options.read ?? readLocal })
}

const listed = (elsewhere: readonly string[]) =>
  elsewhere.length > 0 ? elsewhere.join(" or ") : "a machine that isn't the user's laptop"

/**
 * Why a call was refused on the user's laptop (`what`: "run blender", "drive its browser"), and
 * where to do it instead.
 */
export const refusal = (what: string, elsewhere: readonly string[] = []): string =>
  `This is the user's own laptop, the machine they work at, so the agent doesn't ${what} here, even while they've stepped away. Do it on ${listed(elsewhere)} instead (its macos extension's exec, files copied there with rsync first). Only when the user asked for exactly this on this machine, call again with ${PERSON_ASKED} (a shell command: led by ${ASKED_VAR}='…'): their words, and when they said them.`

const SHIMS = ["cargo", "swift", "xcodebuild", "xcrun", "ffmpeg"]

const shq = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

/**
 * Writes PATH stand-ins into `dir` for what a script runs to build, test or encode: each refuses
 * that, unless PERSON_ASKED is set, and runs the real program (on PATH past `dir`) for the rest.
 * Returns `dir`, to put first on PATH.
 */
export const standIns = (dir: string, elsewhere: readonly string[] = []): string => {
  mkdirSync(dir, { recursive: true })
  const said = refusal("run $heavy, even from a script,", elsewhere)
  const script = `#!/bin/sh
# Put first on PATH on the user's own laptop, so heavy work refuses even from inside a script.
name=\${0##*/}
first=
for arg in "$@"; do case "$arg" in -*|+*) ;; *) first=$arg; break;; esac; done
heavy=
case "$name" in
  cargo|swift) case "$first" in build|test|clippy|check|run|bench|nextest|install) heavy="$name $first";; esac;;
  xcrun) case "$first" in xcodebuild|simctl) heavy="$first";; esac;;
  *) heavy=$name;;
esac
case "$*" in *--version*|*-version*|*--help*|*-showsdks*) heavy=;; esac
if [ "$name" = xcrun ] && [ "$first" = simctl ]; then
  for arg in "$@"; do case "$arg" in list|shutdown|delete|help|getenv|runtime) heavy=; break;; esac; done
fi
if [ -n "$heavy" ] && [ \${#${ASKED_VAR}} -lt ${ASKED_MIN} ]; then
  echo "${said.replaceAll('"', '\\"')}" >&2
  exit 126
fi
here=${shq(dir)}
PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF "$here" | paste -sd: -)
export PATH
exec "$name" "$@"
`
  for (const name of SHIMS) {
    const file = path.join(dir, name)
    if (!existsSync(file) || readFileSync(file, "utf-8") !== script) {
      const partial = path.join(dir, `.${name}.new`)
      writeFileSync(partial, script)
      chmodSync(partial, 0o755)
      renameSync(partial, file)
    }
  }
  return dir
}
