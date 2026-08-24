#!/usr/bin/env node
/**
 * MCP over Streamable HTTP — the deployed entrypoint (src/adapters/mcp/
 * streamable-http-server.ts). Mirrors stdio.ts's wiring otherwise: real
 * Postgres + system clock always, FakePaymentProvider unless
 * PAYMENT_PROVIDER=razorpay is explicit (see that file's comment for why).
 *
 * Also runs both Slice 5 background jobs (hold-expiry, no-show-eligibility)
 * on the same process — prompts/slice-7.md: "The background worker running
 * in the deployed process." Neither binds a port or holds connection-
 * specific state, so folding their tick loops in here (same as
 * src/adapters/worker/background.ts does standalone, for local dev) costs
 * nothing and avoids a fourth Railway service just to run a `setInterval`.
 * The Slice 4 authorisation-lapse worker (src/adapters/worker/
 * authorization-lapse.ts) is the same story, folded in below it.
 */
import { runAuthorizationLapseWorker } from '../../app/authorization-lapse-worker.js'
import { runHoldExpiryWorker } from '../../app/hold-expiry-worker.js'
import { runNoShowEligibilityWorker } from '../../app/no-show-eligibility-worker.js'
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'
import { createMcpHttpServer } from './streamable-http-server.js'

loadEnvFile()

const { db } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db)

const app = createMcpHttpServer(deps)
// Railway assigns the public port via $PORT; MCP_HTTP_PORT stays the
// local-dev default (mirrors merchant-api's MERCHANT_API_PORT).
const port = Number(process.env['PORT'] ?? process.env['MCP_HTTP_PORT'] ?? 4000)
await app.listen({ port, host: '0.0.0.0' })
console.log(`MCP Streamable HTTP server listening on :${port}`)

const backgroundIntervalMs = Number(process.env['BACKGROUND_WORKER_INTERVAL_MS'] ?? 60_000)

async function backgroundTick(): Promise<void> {
  const { expiredBookingIds } = await runHoldExpiryWorker(deps)
  if (expiredBookingIds.length > 0) {
    console.log(`background worker: HOLD_EXPIRED for ${expiredBookingIds.length} booking(s): ${expiredBookingIds.join(', ')}`)
  }

  const { eligibleBookingIds } = await runNoShowEligibilityWorker(deps)
  if (eligibleBookingIds.length > 0) {
    console.log(`background worker: NO_SHOW_ELIGIBLE for ${eligibleBookingIds.length} booking(s): ${eligibleBookingIds.join(', ')}`)
  }
}

console.log(`background worker started, polling every ${backgroundIntervalMs}ms`)
// Deliberately not `await`ed unguarded: an unhandled rejection here (e.g. a
// first-tick race against migrations not having run yet on a fresh deploy)
// would crash this entire process — taking the public MCP endpoint down
// over a background-job failure, exactly the opposite of what folding the
// workers into this process was supposed to buy.
backgroundTick().catch((err) => console.error('background worker tick failed:', err))
setInterval(() => {
  backgroundTick().catch((err) => console.error('background worker tick failed:', err))
}, backgroundIntervalMs)

const authLapseIntervalMs = Number(process.env['AUTHORIZATION_LAPSE_WORKER_INTERVAL_MS'] ?? 60_000)

async function authorizationLapseTick(): Promise<void> {
  const { lapsedBookingIds } = await runAuthorizationLapseWorker(deps)
  if (lapsedBookingIds.length > 0) {
    console.log(`authorization-lapse worker: recorded AUTHORIZATION_LAPSED for ${lapsedBookingIds.length} booking(s): ${lapsedBookingIds.join(', ')}`)
  }
}

console.log(`authorization-lapse worker started, polling every ${authLapseIntervalMs}ms`)
authorizationLapseTick().catch((err) => console.error('authorization-lapse worker tick failed:', err))
setInterval(() => {
  authorizationLapseTick().catch((err) => console.error('authorization-lapse worker tick failed:', err))
}, authLapseIntervalMs)
