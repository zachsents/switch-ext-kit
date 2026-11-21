// The extension as a stdio MCP server.
import { serveStdio } from "switch-ext-kit"

import { helloApp, Notes } from "./app.ts"

await serveStdio(helloApp, Notes.layer)
