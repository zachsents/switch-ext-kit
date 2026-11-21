// An extension's entry: its app served as MCP on stdio, until the client (its host) goes.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Effect, Layer } from "effect"

import { AppEvents, serve } from "./app.ts"
import type { App, AppEventsService } from "./app.ts"

/** Serves `app` on stdio with `layer`, its services (`Layer.empty` for none), until stdin closes. */
export const serveStdio = async <R, E>(
  app: App<R>,
  layer: Layer.Layer<R, E, AppEventsService>,
): Promise<void> => {
  await Effect.runPromise(
    Effect.scoped(Effect.flatten(serve(app, new StdioServerTransport()))).pipe(
      Effect.provide(Layer.provideMerge(layer, AppEvents.layer(app))),
    ),
  )
}
