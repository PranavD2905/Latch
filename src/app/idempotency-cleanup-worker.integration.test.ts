import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
import { PostgresWebhookDeadLetterStore } from '../adapters/db/postgres-webhook-dead-letter-store.js'
import { SEED_MERCHANT_ID } from '../adapters/db/seed-data.js'
import { idempotencyKeys } from '../adapters/db/schema.js'
import { createNoopLogger } from '../adapters/observability/noop-logger.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { runIdempotencyCleanupWorker } from './idempotency-cleanup-worker.js'
import type { AppDeps } from './types.js'

/**
 * dev-logs/021. `claim`/`put` stamp `createdAt` from the real wall clock
 * (`new Date()`), not the injected `Clock` port — unlike everything else
 * timing-sensitive in this codebase, this store predates the `Clock`
 * discipline and this task didn't expand its port surface just to fix that.
 * So rows are backdated directly here, bypassing the store's own API, the
 * same way other integration tests reach into `bookings`/`events` directly
 * for fixture setup — a legitimate test-setup technique, not something
 * production code does.
 */
process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)
const store = new PostgresIdempotencyStore(db)

const SCOPE = 'idempotency_cleanup_test'
const NOW = new Date('2026-08-28T00:00:00Z')
const PENDING_MAX_AGE_MS = 60 * 60 * 1000 // 1 hour — matches the worker's own constant
const COMPLETED_GRACE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days — matches the worker's own constant

async function backdate(key: string, age: number): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ createdAt: new Date(NOW.getTime() - age) })
    .where(and(eq(idempotencyKeys.scope, SCOPE), eq(idempotencyKeys.key, key)))
}

async function rowExists(key: string): Promise<boolean> {
  const rows = await db
    .select({ key: idempotencyKeys.key })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, SCOPE), eq(idempotencyKeys.key, key)))
  return rows.length > 0
}

function freshKey(): string {
  return `test_${ulid()}`
}

afterAll(async () => {
  await sql.end()
})

describe('IdempotencyStore.deleteExpired', () => {
  it('deletes a completed row past its grace period, and leaves one inside it alone', async () => {
    const oldKey = freshKey()
    const recentKey = freshKey()
    await store.put(SCOPE, oldKey, { ok: true })
    await store.put(SCOPE, recentKey, { ok: true })
    await backdate(oldKey, COMPLETED_GRACE_MS + 1000)
    await backdate(recentKey, COMPLETED_GRACE_MS - 1000)

    const { deletedCount } = await store.deleteExpired(NOW, { pendingMaxAgeMs: PENDING_MAX_AGE_MS, completedGraceMs: COMPLETED_GRACE_MS })

    expect(deletedCount).toBeGreaterThanOrEqual(1)
    expect(await rowExists(oldKey)).toBe(false)
    expect(await rowExists(recentKey)).toBe(true)
  })

  it('deletes a stale pending row (a crashed claimant), and leaves a fresh one alone', async () => {
    const staleKey = freshKey()
    const freshPendingKey = freshKey()
    const staleClaim = await store.claim(SCOPE, staleKey, { timeoutMs: 10 })
    expect(staleClaim.kind).toBe('claimed')
    const freshClaim = await store.claim(SCOPE, freshPendingKey, { timeoutMs: 10 })
    expect(freshClaim.kind).toBe('claimed')
    await backdate(staleKey, PENDING_MAX_AGE_MS + 1000)
    await backdate(freshPendingKey, PENDING_MAX_AGE_MS - 1000)

    const { deletedCount } = await store.deleteExpired(NOW, { pendingMaxAgeMs: PENDING_MAX_AGE_MS, completedGraceMs: COMPLETED_GRACE_MS })

    expect(deletedCount).toBeGreaterThanOrEqual(1)
    expect(await rowExists(staleKey)).toBe(false)
    expect(await rowExists(freshPendingKey)).toBe(true)

    // The whole point: a key stuck behind a crashed claimant becomes
    // claimable again, rather than permanently returning IDEMPOTENT_REPLAY.
    const reclaim = await store.claim(SCOPE, staleKey, { timeoutMs: 10 })
    expect(reclaim.kind).toBe('claimed')
    await store.release(SCOPE, staleKey)
  })

  it('never deletes a pending row still inside a legitimate claim window, even if it were the only thing due for GC', async () => {
    const liveKey = freshKey()
    await store.claim(SCOPE, liveKey, { timeoutMs: 10 })
    // Deliberately not backdated — createdAt stays "now," simulating a claim
    // that started this instant.
    await store.deleteExpired(NOW, { pendingMaxAgeMs: PENDING_MAX_AGE_MS, completedGraceMs: COMPLETED_GRACE_MS })

    expect(await rowExists(liveKey)).toBe(true)
    await store.release(SCOPE, liveKey)
  })
})

describe('runIdempotencyCleanupWorker', () => {
  it('wires deleteExpired with the real 1-hour/7-day thresholds against deps.clock', async () => {
    const oldKey = freshKey()
    await store.put(SCOPE, oldKey, { ok: true })
    await backdate(oldKey, 8 * 24 * 60 * 60 * 1000) // 8 days — past the real 7-day grace

    const clock = new FrozenClock(NOW)
    const deps: AppDeps = {
      clock,
      logger: createNoopLogger(),
      eventStore: new PostgresEventStore(db),
      catalogRepo: new PostgresCatalogRepo(db),
      paymentProvider: new FakePaymentProvider(),
      paymentRail: new FakePaymentRail(),
      idempotencyStore: store,
      reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
      paymentCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
      webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
      merchantId: SEED_MERCHANT_ID,
    }
    const { deletedCount } = await runIdempotencyCleanupWorker(deps)

    expect(deletedCount).toBeGreaterThanOrEqual(1)
    expect(await rowExists(oldKey)).toBe(false)
  })
})
