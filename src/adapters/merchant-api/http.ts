#!/usr/bin/env node
/**
 * The merchant API over HTTP, for local dev and for the merchant-decline
 * demo. Mirrors src/adapters/mcp/stdio.ts's wiring (real Postgres + system
 * clock always; FakePaymentProvider unless PAYMENT_PROVIDER=razorpay is
 * explicit) — see that file's comment for why the Razorpay provider is
 * opt-in rather than automatic.
 */
import { buildAppDeps, buildMerchantAuthStore, buildWebhookOptions, requireDatabaseUrl } from '../build-deps.js'
import { loadEnv } from '../config.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'
import { setupGracefulShutdown } from '../observability/graceful-shutdown.js'
import { createLogger } from '../observability/logger.js'
import { createMerchantApiServer } from './server.js'

loadEnvFile()

const env = loadEnv()
const logger = createLogger('latch-merchant-api')
const { db, sql } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db, logger)
// Migration 0011: per-merchant, DB-issued credentials replace the old
// MERCHANT_API_TOKEN env var — see `src/adapters/db/seed.ts` /
// `src/adapters/db/create-merchant.ts` for how a merchant gets one.
const merchantAuthStore = buildMerchantAuthStore(db)

const webhook = buildWebhookOptions()
if (!webhook) {
  logger.warn({}, 'RAZORPAY_WEBHOOK_SECRET not set — POST /webhooks/razorpay will return 503 (dev-logs/014)')
}
const app = createMerchantApiServer(deps, webhook ? { merchantAuthStore, webhook } : { merchantAuthStore })
// Railway assigns the public port via $PORT for whichever service this
// process is deployed as; MERCHANT_API_PORT stays the local-dev default.
const port = env.PORT ?? env.MERCHANT_API_PORT
await app.listen({ port, host: '0.0.0.0' })
logger.info({ port }, 'merchant API listening')

setupGracefulShutdown(logger, { app, timeoutMs: env.GRACEFUL_SHUTDOWN_TIMEOUT_MS, onShutdown: [() => sql.end()] })
