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
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'

loadEnvFile()

const { db } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db)

const intervalMs = Number(process.env['RECONCILIATION_WORKER_INTERVAL_MS'] ?? 60_000)

async function tick(): Promise<void> {
  const { mismatchedBookingIds } = await runReconciliationWorker(deps)
  if (mismatchedBookingIds.length > 0) {
    console.log(`reconciliation worker: RECONCILIATION_MISMATCH for ${mismatchedBookingIds.length} booking(s): ${mismatchedBookingIds.join(', ')}`)
  }
}

console.log(`reconciliation worker started, polling every ${intervalMs}ms`)
await tick()
setInterval(() => {
  tick().catch((err) => console.error('reconciliation worker tick failed:', err))
}, intervalMs)
