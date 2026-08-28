#!/usr/bin/env node
/**
 * The standalone REST adapter over HTTP, for local dev (`npm run rest:dev`)
 * and as a directly-curlable demonstration that `GET /slots` needs nothing
 * merchant-api-specific to run — see `server.ts`'s comment. Mirrors every
 * other entrypoint's wiring (real Postgres + system clock always).
 */
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'
import { createLogger } from '../observability/logger.js'
import { createRestServer } from './server.js'

loadEnvFile()

const logger = createLogger('latch-rest')
const { db } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db, logger)

const app = createRestServer(deps)
const port = Number(process.env['PORT'] ?? process.env['REST_PORT'] ?? 4003)
await app.listen({ port, host: '0.0.0.0' })
logger.info({ port }, 'REST adapter (GET /slots) listening')
