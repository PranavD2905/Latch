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
import { withGlobalLock } from '../db/advisory-lock.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'

loadEnvFile()

const { db, sql } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db)

const intervalMs = Number(process.env['AUTHORIZATION_LAPSE_WORKER_INTERVAL_MS'] ?? 60_000)

// Same global-advisory-lock guard as `mcp/http.ts`'s own copy of this tick —
// see `advisory-lock.ts`.
async function tick(): Promise<void> {
  await withGlobalLock(sql, 'latch:authorization-lapse-worker-tick', async () => {
    const { lapsedBookingIds } = await runAuthorizationLapseWorker(deps)
    if (lapsedBookingIds.length > 0) {
      console.log(`authorization-lapse worker: recorded AUTHORIZATION_LAPSED for ${lapsedBookingIds.length} booking(s): ${lapsedBookingIds.join(', ')}`)
    }
  })
}

console.log(`authorization-lapse worker started, polling every ${intervalMs}ms`)
await tick()
setInterval(() => {
  tick().catch((err) => console.error('authorization-lapse worker tick failed:', err))
}, intervalMs)
