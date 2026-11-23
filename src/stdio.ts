// An extension's entry: its app served as MCP on stdio, until the client (its host) goes. Its host
// runs it in its own folder, which holds its outbox (`events.db`) beside the rest of its state.
import path from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Effect, Layer } from "effect"

import { AppEvents, serve } from "./app.ts"
import type { App, AppEventsService } from "./app.ts"

/**
 * Where an extension keeps the events it emitted until the core has them: in its folder, the
 * folder it runs in. Resolved when served, never on import: the desktop webview imports this
 * package's root, and there `node:path` is empty, so a call at load blanked its window.
 */
export const OUTBOX_FILE = "events.db"

/** Serves `app` on stdio with `layer`, its services (`Layer.empty` for none), until stdin closes. */
export const serveStdio = async <R, E>(
  app: App<R>,
  layer: Layer.Layer<R, E, AppEventsService>,
): Promise<void> => {
  await Effect.runPromise(
    Effect.scoped(Effect.flatten(serve(app, new StdioServerTransport()))).pipe(
      Effect.provide(Layer.provideMerge(layer, AppEvents.layer(app, path.resolve(OUTBOX_FILE)))),
    ),
  )
}
