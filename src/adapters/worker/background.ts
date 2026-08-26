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
import { runNoShowEligibilityWorker } from '../../app/no-show-eligibility-worker.js'
import { runReconciliationWorker } from '../../app/reconciliation-worker.js'
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { withGlobalLock } from '../db/advisory-lock.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'

loadEnvFile()

const { db, sql } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db)

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
      console.log(`background worker: HOLD_EXPIRED for ${expiredBookingIds.length} booking(s): ${expiredBookingIds.join(', ')}`)
    }

    const { eligibleBookingIds } = await runNoShowEligibilityWorker(deps)
    if (eligibleBookingIds.length > 0) {
      console.log(`background worker: NO_SHOW_ELIGIBLE for ${eligibleBookingIds.length} booking(s): ${eligibleBookingIds.join(', ')}`)
    }

    // dev-logs/014, item 1 — folded in here rather than its own interval so
    // this file stays "the one process for periodic, non-authorisation-lapse
    // background work," same reasoning docs/07-deployment.md already gives for
    // combining hold-expiry and no-show-eligibility.
    const { mismatchedBookingIds } = await runReconciliationWorker(deps)
    if (mismatchedBookingIds.length > 0) {
      console.log(`background worker: RECONCILIATION_MISMATCH for ${mismatchedBookingIds.length} booking(s): ${mismatchedBookingIds.join(', ')}`)
    }
  })
}

console.log(`background worker started, polling every ${intervalMs}ms`)
await tick()
setInterval(() => {
  tick().catch((err) => console.error('background worker tick failed:', err))
}, intervalMs)
