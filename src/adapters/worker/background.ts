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
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'

loadEnvFile()

const { db } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db)

const intervalMs = Number(process.env['BACKGROUND_WORKER_INTERVAL_MS'] ?? 60_000)

async function tick(): Promise<void> {
  const { expiredBookingIds } = await runHoldExpiryWorker(deps)
  if (expiredBookingIds.length > 0) {
    console.log(`background worker: HOLD_EXPIRED for ${expiredBookingIds.length} booking(s): ${expiredBookingIds.join(', ')}`)
  }

  const { eligibleBookingIds } = await runNoShowEligibilityWorker(deps)
  if (eligibleBookingIds.length > 0) {
    console.log(`background worker: NO_SHOW_ELIGIBLE for ${eligibleBookingIds.length} booking(s): ${eligibleBookingIds.join(', ')}`)
  }
}

console.log(`background worker started, polling every ${intervalMs}ms`)
await tick()
setInterval(() => {
  tick().catch((err) => console.error('background worker tick failed:', err))
}, intervalMs)
