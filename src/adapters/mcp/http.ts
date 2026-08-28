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
import { runIdempotencyCleanupWorker } from '../../app/idempotency-cleanup-worker.js'
import { runNoShowEligibilityWorker } from '../../app/no-show-eligibility-worker.js'
import { runReconciliationWorker } from '../../app/reconciliation-worker.js'
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { withGlobalLock } from '../db/advisory-lock.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'
import { createLogger } from '../observability/logger.js'
import { createMcpHttpServer } from './streamable-http-server.js'

loadEnvFile()

const logger = createLogger('latch-mcp')
const { db, sql } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db, logger)

const app = await createMcpHttpServer(deps)
// Railway assigns the public port via $PORT; MCP_HTTP_PORT stays the
// local-dev default (mirrors merchant-api's MERCHANT_API_PORT).
const port = Number(process.env['PORT'] ?? process.env['MCP_HTTP_PORT'] ?? 4000)
await app.listen({ port, host: '0.0.0.0' })
logger.info({ port }, 'MCP Streamable HTTP server listening')

const backgroundIntervalMs = Number(process.env['BACKGROUND_WORKER_INTERVAL_MS'] ?? 60_000)

/**
 * Scalability: guarded by a single global advisory lock (`withGlobalLock`)
 * so that setting `replicas > 1` on this service (docs/07-deployment.md
 * never sets `replicas` today, precisely because nothing made that safe)
 * doesn't turn one tick's worth of work — in particular the reconciliation
 * leg's real Razorpay calls — into N replicas' worth of duplicated external
 * calls every interval. Whichever replica's `sql.reserve()`d connection gets
 * the lock first runs the tick; the rest see `ran: false` and skip this
 * round, trying again next interval.
 */
async function backgroundTick(): Promise<void> {
  // Not logging the `ran: false` case — with `replicas > 1` this fires on
  // every idle replica every interval, which is noise, not signal.
  await withGlobalLock(sql, 'latch:background-worker-tick', async () => {
    const { expiredBookingIds } = await runHoldExpiryWorker(deps)
    if (expiredBookingIds.length > 0) {
      logger.info({ expiredBookingIds, count: expiredBookingIds.length, workerType: 'hold-expiry' }, 'background worker completed')
    }

    const { eligibleBookingIds } = await runNoShowEligibilityWorker(deps)
    if (eligibleBookingIds.length > 0) {
      logger.info({ eligibleBookingIds, count: eligibleBookingIds.length, workerType: 'no-show-eligibility' }, 'background worker completed')
    }

    // dev-logs/014, item 1 — see docs/07-deployment.md: folded into this same
    // process for the same reason the other two workers are.
    const { mismatchedBookingIds } = await runReconciliationWorker(deps)
    if (mismatchedBookingIds.length > 0) {
      logger.info({ mismatchedBookingIds, count: mismatchedBookingIds.length, workerType: 'reconciliation' }, 'background worker completed')
    }

    const { deletedCount } = await runIdempotencyCleanupWorker(deps)
    if (deletedCount > 0) {
      logger.info({ deletedCount, workerType: 'idempotency-cleanup' }, 'background worker completed')
    }
  })
}

logger.info({ intervalMs: backgroundIntervalMs }, 'background worker started')
// Deliberately not `await`ed unguarded: an unhandled rejection here (e.g. a
// first-tick race against migrations not having run yet on a fresh deploy)
// would crash this entire process — taking the public MCP endpoint down
// over a background-job failure, exactly the opposite of what folding the
// workers into this process was supposed to buy.
backgroundTick().catch((err) => logger.error({ err }, 'background worker tick failed'))
setInterval(() => {
  backgroundTick().catch((err) => logger.error({ err }, 'background worker tick failed'))
}, backgroundIntervalMs)

const authLapseIntervalMs = Number(process.env['AUTHORIZATION_LAPSE_WORKER_INTERVAL_MS'] ?? 60_000)

async function authorizationLapseTick(): Promise<void> {
  await withGlobalLock(sql, 'latch:authorization-lapse-worker-tick', async () => {
    const { lapsedBookingIds } = await runAuthorizationLapseWorker(deps)
    if (lapsedBookingIds.length > 0) {
      logger.info({ lapsedBookingIds, count: lapsedBookingIds.length, workerType: 'authorization-lapse' }, 'background worker completed')
    }
  })
}

logger.info({ intervalMs: authLapseIntervalMs }, 'authorization-lapse worker started')
authorizationLapseTick().catch((err) => logger.error({ err }, 'authorization-lapse worker tick failed'))
setInterval(() => {
  authorizationLapseTick().catch((err) => logger.error({ err }, 'authorization-lapse worker tick failed'))
}, authLapseIntervalMs)
