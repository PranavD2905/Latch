#!/usr/bin/env node
/**
 * The standalone REST adapter over HTTP, for local dev (`npm run rest:dev`)
 * and as a directly-curlable demonstration that `GET /slots` needs nothing
 * merchant-api-specific to run — see `server.ts`'s comment. Mirrors every
 * other entrypoint's wiring (real Postgres + system clock always).
 */
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { loadEnv } from '../config.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'
import { setupGracefulShutdown } from '../observability/graceful-shutdown.js'
import { shutdownTracing, startTracing } from '../observability/tracing.js'
import { createLogger } from '../observability/logger.js'
import { createRestServer } from './server.js'

loadEnvFile()

const env = loadEnv()
const logger = createLogger('latch-rest')
startTracing('latch-rest')
const { db, sql } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db, logger)

const app = createRestServer(deps)
const port = env.PORT ?? env.REST_PORT
await app.listen({ port, host: '0.0.0.0' })
logger.info({ port }, 'REST adapter (GET /slots) listening')

setupGracefulShutdown(logger, { app, timeoutMs: env.GRACEFUL_SHUTDOWN_TIMEOUT_MS, onShutdown: [shutdownTracing, () => sql.end()] })
