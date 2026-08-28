#!/usr/bin/env node
/**
 * Runs the reconciliation worker (`src/app/reconciliation-worker.ts`) on an
 * interval, standalone — dev-logs/014, item 1. Mirrors `worker/authorization-
 * lapse.ts`'s wiring (real Postgres + system clock always,
 * `PAYMENT_PROVIDER=razorpay` opt-in for the real provider/rail — this
 * worker is the one place a `FakePaymentProvider`/`FakePaymentRail` run
 * genuinely does something interesting: fetchPaymentStatus/
 * fetchAuthorizationStatus on the fakes reflect exactly what this same
 * process captured, so mismatches only ever appear against real Razorpay,
 * which is the honest behaviour for a demo run without real credentials).
 * Folded into `mcp/http.ts` for the deployed process (docs/07-deployment.md);
 * this file exists for local dev/testing the worker in isolation.
 */
import { runReconciliationWorker } from '../../app/reconciliation-worker.js'
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { loadEnv } from '../config.js'
import { withGlobalLock } from '../db/advisory-lock.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'
import { setupGracefulShutdown } from '../observability/graceful-shutdown.js'
import { createLogger } from '../observability/logger.js'

loadEnvFile()

const env = loadEnv()
const logger = createLogger('latch-worker-reconciliation')
const { db, sql } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db, logger)

const intervalMs = env.RECONCILIATION_WORKER_INTERVAL_MS

// Same global-advisory-lock guard as `mcp/http.ts`'s own copy of this tick
// (the one that actually matters most here — this is the job with real
// outbound Razorpay calls per candidate) — see `advisory-lock.ts`.
async function tick(): Promise<void> {
  await withGlobalLock(sql, 'latch:background-worker-tick', async () => {
    const { mismatchedBookingIds, circuitOpen } = await runReconciliationWorker(deps)
    if (mismatchedBookingIds.length > 0) {
      logger.info({ mismatchedBookingIds, count: mismatchedBookingIds.length, workerType: 'reconciliation' }, 'background worker completed')
    }
    if (circuitOpen) {
      logger.error({}, 'reconciliation worker: circuit open — Razorpay looks down, this tick skipped some or all remaining checks rather than hammering it')
    }
  })
}

logger.info({ intervalMs }, 'reconciliation worker started')
await tick()
const interval = setInterval(() => {
  tick().catch((err) => logger.error({ err }, 'reconciliation worker tick failed'))
}, intervalMs)

setupGracefulShutdown(logger, { timeoutMs: env.GRACEFUL_SHUTDOWN_TIMEOUT_MS, onShutdown: [() => clearInterval(interval), () => sql.end()] })
