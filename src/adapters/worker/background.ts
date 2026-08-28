#!/usr/bin/env node
/**
 * Runs the two Slice 5 background jobs (`src/app/hold-expiry-worker.ts`,
 * `src/app/no-show-eligibility-worker.ts`) on one shared interval — docs/02-
 * tech-stack.md §9: "We run an interval inside the main Node process that
 * queries for due work." Distinct from `worker/authorization-lapse.ts`
 * (Slice 4), which is its own narrower, separately-scoped process. Mirrors
 * that entrypoint's wiring: real Postgres + system clock always,
 * `PAYMENT_PROVIDER=razorpay` opt-in for the real rail (only relevant here
 * because `buildAppDeps` always constructs one, even though neither job in
 * this process calls it).
 */
import { runHoldExpiryWorker } from '../../app/hold-expiry-worker.js'
import { runIdempotencyCleanupWorker } from '../../app/idempotency-cleanup-worker.js'
import { runNoShowEligibilityWorker } from '../../app/no-show-eligibility-worker.js'
import { runReconciliationWorker } from '../../app/reconciliation-worker.js'
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { withGlobalLock } from '../db/advisory-lock.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'
import { setupGracefulShutdown } from '../observability/graceful-shutdown.js'
import { createLogger } from '../observability/logger.js'

loadEnvFile()

const logger = createLogger('latch-worker-background')
const { db, sql } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db, logger)

const intervalMs = Number(process.env['BACKGROUND_WORKER_INTERVAL_MS'] ?? 60_000)

// Same global-advisory-lock guard `mcp/http.ts` uses on its own copy of this
// tick — see `advisory-lock.ts`'s doc comment. Not load-bearing for this
// standalone entrypoint today (docs/07-deployment.md never deploys it
// alongside `mcp/http.ts`'s own in-process copy), but keeping the two
// implementations identical means running this file for local testing
// exercises the exact locking behaviour production relies on.
async function tick(): Promise<void> {
  await withGlobalLock(sql, 'latch:background-worker-tick', async () => {
    const { expiredBookingIds } = await runHoldExpiryWorker(deps)
    if (expiredBookingIds.length > 0) {
      logger.info({ expiredBookingIds, count: expiredBookingIds.length, workerType: 'hold-expiry' }, 'background worker completed')
    }

    const { eligibleBookingIds } = await runNoShowEligibilityWorker(deps)
    if (eligibleBookingIds.length > 0) {
      logger.info({ eligibleBookingIds, count: eligibleBookingIds.length, workerType: 'no-show-eligibility' }, 'background worker completed')
    }

    // dev-logs/014, item 1 — folded in here rather than its own interval so
    // this file stays "the one process for periodic, non-authorisation-lapse
    // background work," same reasoning docs/07-deployment.md already gives for
    // combining hold-expiry and no-show-eligibility.
    const { mismatchedBookingIds, circuitOpen } = await runReconciliationWorker(deps)
    if (mismatchedBookingIds.length > 0) {
      logger.info({ mismatchedBookingIds, count: mismatchedBookingIds.length, workerType: 'reconciliation' }, 'background worker completed')
    }
    if (circuitOpen) {
      logger.error({}, 'background worker: circuit open — Razorpay looks down, this tick skipped some or all remaining reconciliation checks rather than hammering it')
    }

    const { deletedCount } = await runIdempotencyCleanupWorker(deps)
    if (deletedCount > 0) {
      logger.info({ deletedCount, workerType: 'idempotency-cleanup' }, 'background worker completed')
    }
  })
}

logger.info({ intervalMs }, 'background worker started')
await tick()
const interval = setInterval(() => {
  tick().catch((err) => logger.error({ err }, 'background worker tick failed'))
}, intervalMs)

setupGracefulShutdown(logger, { onShutdown: [() => clearInterval(interval), () => sql.end()] })
