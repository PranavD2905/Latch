#!/usr/bin/env node
/**
 * Runs the authorisation-lapse worker (`src/app/authorization-lapse-worker.ts`)
 * on an interval. docs/01-architecture.md §8: "Authorisation lapse | 5-day
 * `manual_expiry_period` passed | Append `AUTHORIZATION_LAPSED`." Mirrors
 * `stdio.ts`/`http.ts`'s wiring — real Postgres + system clock always,
 * `PAYMENT_PROVIDER=razorpay` opt-in for the real rail.
 */
import { runAuthorizationLapseWorker } from '../../app/authorization-lapse-worker.js'
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { loadEnv } from '../config.js'
import { withGlobalLock } from '../db/advisory-lock.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'
import { setupGracefulShutdown } from '../observability/graceful-shutdown.js'
import { shutdownTracing, startTracing } from '../observability/tracing.js'
import { createLogger } from '../observability/logger.js'

loadEnvFile()

const env = loadEnv()
const logger = createLogger('latch-worker-authorization-lapse')
startTracing('latch-worker-authorization-lapse')
const { db, sql } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db, logger)

const intervalMs = env.AUTHORIZATION_LAPSE_WORKER_INTERVAL_MS

// Same global-advisory-lock guard as `mcp/http.ts`'s own copy of this tick —
// see `advisory-lock.ts`.
async function tick(): Promise<void> {
  await withGlobalLock(sql, 'latch:authorization-lapse-worker-tick', async () => {
    const { lapsedBookingIds } = await runAuthorizationLapseWorker(deps)
    if (lapsedBookingIds.length > 0) {
      logger.info({ lapsedBookingIds, count: lapsedBookingIds.length, workerType: 'authorization-lapse' }, 'background worker completed')
    }
  })
}

logger.info({ intervalMs }, 'authorization-lapse worker started')
await tick()
const interval = setInterval(() => {
  tick().catch((err) => logger.error({ err }, 'authorization-lapse worker tick failed'))
}, intervalMs)

setupGracefulShutdown(logger, { timeoutMs: env.GRACEFUL_SHUTDOWN_TIMEOUT_MS, onShutdown: [() => clearInterval(interval), shutdownTracing, () => sql.end()] })
