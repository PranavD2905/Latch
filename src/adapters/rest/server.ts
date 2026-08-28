import Fastify, { type FastifyInstance } from 'fastify'
import type { AppDeps } from '../../app/types.js'
import { echoTraceIdHeader, loggingFastifyOptions, registerErrorHandler } from '../observability/fastify-logging.js'
import { registerMetricsRoute } from '../observability/metrics.js'
import { registerSlotsRoute } from './slots.js'

/**
 * dev-logs/014, item 4 — a genuinely standalone REST adapter, unauthenticated
 * and un-gated exactly like the MCP `find_slots` tool (no money, no gate, no
 * bound: docs/01-architecture.md §3's table has `find_slots` at "none" for
 * all three columns). `registerSlotsRoute` is the actual proof that this
 * reuses the domain core unchanged — see its own doc comment. This file
 * exists so the adapter can be run and curled entirely on its own
 * (`npm run rest:dev`), independent of the merchant API it also happens to
 * be mounted onto in the deployed topology (`src/adapters/merchant-api/server.ts`)
 * for reachability without a fourth Railway service.
 */
export function createRestServer(deps: AppDeps): FastifyInstance {
  const app = Fastify(loggingFastifyOptions(deps.logger))
  echoTraceIdHeader(app)
  registerErrorHandler(app)
  app.get('/healthz', async () => ({ ok: true }))
  registerMetricsRoute(app)
  registerSlotsRoute(app, deps)
  return app
}
