// Widget helpers: a widget's A2UI messages for one surface, an MCP App inside A2UI's `McpApp`, and
// an MCP App view as one HTML document with its script bundled in, since a view loads nothing from
// outside. `view` runs bun's CLI, so call it as the extension starts: Bun runs no macros from an
// installed package.

/** Switch's own A2UI catalog: the house components, rendered by each client. */
export const SWITCH_CATALOG = "https://switch.ax/catalogs/v1/catalog.json"
export const BASIC_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"
export const MCP_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/mcp/catalog.json"

/** One surface's messages: made in `catalog`, then its components (one has id `root`). */
export const surface = (
  id: string,
  catalog: string,
  components: readonly Record<string, unknown>[],
): readonly unknown[] => [
  { version: "1.0", createSurface: { surfaceId: id, catalogId: catalog } },
  { version: "1.0", updateComponents: { surfaceId: id, components } },
]

/** A surface that is one MCP App: `html` in A2UI's `McpApp`, calling only `allowedTools`. */
export const mcpApp = (
  id: string,
  options: {
    readonly title: string
    readonly html: string
    readonly allowedTools?: readonly string[]
    /** JSON Pointer to the widget input the host sends as MCP App tool-input. */
    readonly toolInput?: string
  },
): readonly unknown[] =>
  surface(id, MCP_CATALOG, [
    {
      id: "root",
      component: "McpApp",
      title: options.title,
      htmlContent: options.html,
      ...(options.toolInput === undefined
        ? {}
        : { data: { paths: { toolInput: options.toolInput } } }),
      ...(options.allowedTools === undefined ? {} : { allowedTools: [...options.allowedTools] }),
    },
  ])

/** `entry` (a browser script, absolute) bundled into an HTML document with `style` and `body`. */
export const view = (
  entry: string,
  options: { readonly style?: string; readonly body?: string; readonly head?: string } = {},
): string => {
  const built = Bun.spawnSync([
    process.execPath,
    "build",
    entry,
    "--target=browser",
    "--format=iife",
    "--minify",
  ])
  if (!built.success) {
    throw new Error(`${entry} didn't build: ${built.stderr.toString()}`)
  }
  const script = built.stdout.toString().replaceAll("</script", String.raw`<\/script`)
  return `<!doctype html><html><head><meta charset="utf-8">${options.head ?? ""}<style>${options.style ?? ""}</style></head><body>${options.body ?? ""}<script>${script}</script></body></html>`
}
