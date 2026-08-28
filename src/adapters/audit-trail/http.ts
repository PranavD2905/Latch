#!/usr/bin/env node
/**
 * The audit-trail SSE server, for local dev and the Slice 6 viewer. Mirrors
 * `src/adapters/merchant-api/http.ts`'s wiring (real Postgres + system clock
 * always; the payment provider/rail are unused by this surface but
 * `buildAppDeps` builds them anyway since `AppDeps` is one shared shape).
 *
 * Slice 7: also serves the built `web/dist` viewer at `/`, same origin as
 * `/events`. Locally this is a no-op unless `npm run build:web` has been run
 * (`npm run web:dev`'s Vite dev server is the normal local path instead) —
 * deployed, this is the one Railway service the viewer's URL points at, so
 * the browser's `EventSource` needs no CORS handling at all, same reasoning
 * `web/vite.config.ts`'s dev-time proxy comment gives.
 */
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildAppDeps, buildMerchantAuthStore, requireDatabaseUrl } from '../build-deps.js'
import { loadEnv } from '../config.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'
import { setupGracefulShutdown } from '../observability/graceful-shutdown.js'
import { createLogger } from '../observability/logger.js'
import { createAuditTrailServer } from './server.js'

loadEnvFile()

const env = loadEnv()
const logger = createLogger('latch-viewer')
const { db, sql } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db, logger)
// Migration 0011: per-merchant, DB-issued credentials replace the old
// AUDIT_TRAIL_TOKEN env var — see `src/adapters/db/seed.ts` /
// `src/adapters/db/create-merchant.ts` for how a merchant gets one.
const merchantAuthStore = buildMerchantAuthStore(db)

const app = createAuditTrailServer(deps, { merchantAuthStore })

// `../../../web/dist` from this file's own directory (src/adapters/audit-trail/
// or, compiled, dist/adapters/audit-trail/ — both 3 levels under the repo
// root) lands on web/dist either way.
const webDist = fileURLToPath(new URL('../../../web/dist', import.meta.url))
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist })
} else {
  logger.info({ webDist }, 'no built web/dist — skipping static viewer (run "npm run build:web" first)')
}

// Railway assigns the public port via $PORT for whichever service this
// process is deployed as; AUDIT_TRAIL_PORT stays the local-dev default.
const port = env.PORT ?? env.AUDIT_TRAIL_PORT
await app.listen({ port, host: '0.0.0.0' })
logger.info({ port }, 'audit trail SSE server listening')

// A short timeout matters more here than anywhere else: an open SSE
// connection (`GET /events`) may never voluntarily close on its own, so the
// backstop (`GRACEFUL_SHUTDOWN_TIMEOUT_MS`, default 10s) is what actually
// lets a deploy finish rather than hanging on whichever browser tab is
// still connected.
setupGracefulShutdown(logger, { app, timeoutMs: env.GRACEFUL_SHUTDOWN_TIMEOUT_MS, onShutdown: [() => sql.end()] })
