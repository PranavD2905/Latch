import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createNoopLogger } from '../adapters/observability/noop-logger.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { PostgresWebhookDeadLetterStore } from '../adapters/db/postgres-webhook-dead-letter-store.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../adapters/db/seed-data.js'
import { bookings, events, policies } from '../adapters/db/schema.js'
import { deletePoliciesForTest } from '../adapters/db/policy-test-cleanup.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import type { BookingEvent } from '../domain/events.js'
import { cancelBooking } from './cancel-booking.js'
import { chargeNoShow } from './charge-no-show.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import { markNoShow } from './mark-no-show.js'
import type { AppDeps } from './types.js'

/**
 * prompts/slice-8.md item 3 — idempotency under genuinely concurrent retry,
 * "not sequentially — sequential retry is the easy case." Fires the *same*
 * idempotency key on `confirm_with_deposit`/`charge_no_show`/`cancel` from
 * several connections simultaneously via `Promise.all`, never awaiting one
 * before starting the next.
 *
 * dev-logs/013: before the claim-based `IdempotencyStore` fix, this was a
 * real bug, not a hypothetical — `get`-then-later-`put` let N concurrent
 * calls with the same key all miss the cache and all re-execute, and since
 * `confirm_with_deposit`/`charge_no_show`/`cancel` only flip the booking's
 * terminal status in the transaction *after* the gate check, every one of
 * them passed the gate and appended its own copy of the same money events —
 * one real payment (deduped at the fake/real provider layer), but N copies
 * of DEPOSIT_CAPTURED/NO_SHOW_CHARGED/CANCELLED_BY_CUSTOMER in the trail.
 */

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))

const deps: AppDeps = {
  clock,
  logger: createNoopLogger(),
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider: new FakePaymentProvider(),
  paymentRail: new FakePaymentRail(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
  merchantId: SEED_MERCHANT_ID,
}

// Thursday 2026-10-01, a day no other integration-test file books against.
const BASE_DAY = '2026-10-01'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}

const createdBookingIds: string[] = []
function freshKey(): string {
  return `test_${ulid()}`
}

async function loadEventLog(bookingId: string): Promise<readonly BookingEvent[]> {
  const rows = await db.select().from(events).where(eq(events.bookingId, bookingId)).orderBy(events.sequence)
  return rows.map((row) => row.payload as BookingEvent)
}

async function holdAndConfirm(hhmm: string): Promise<{ bookingId: string; startsAt: Date; agentId: string }> {
  const startsAt = slotAt(hhmm)
  const agentId = `agent_${ulid()}`
  const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
  createdBookingIds.push(held.bookingId)
  const policyResult = await getPolicy(deps)
  await confirmWithDeposit({ bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() }, deps)
  return { bookingId: held.bookingId, startsAt, agentId }
}

beforeAll(async () => {
  const policy = await deps.catalogRepo.getActivePolicy(SEED_MERCHANT_ID)
  if (!policy) {
    throw new Error('seed data missing — run `npm run db:seed` before this test suite')
  }
})

afterAll(async () => {
  for (const bookingId of createdBookingIds) {
    await db.delete(events).where(eq(events.bookingId, bookingId))
    await db.delete(bookings).where(eq(bookings.bookingId, bookingId))
  }
  await sql.end()
})

describe('idempotency under genuinely concurrent retry (docs/01-architecture.md §6, prompts/slice-8.md item 3)', () => {
  it('confirm_with_deposit: N simultaneous calls with the same key produce one capture, one authorization, one set of events', async () => {
    clock.set(new Date(slotAt('09:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)
    const policyResult = await getPolicy(deps)

    const key = freshKey()
    const N = 6
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        confirmWithDeposit({ bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: key }, deps),
      ),
    )

    // Every caller sees the exact same payment/authorization — one real money movement, N replays.
    const paymentIds = new Set(results.map((r) => r.deposit.paymentId))
    const authorizationIds = new Set(results.map((r) => r.authorization!.authorizationId))
    expect(paymentIds.size).toBe(1)
    expect(authorizationIds.size).toBe(1)

    const trail = await loadEventLog(held.bookingId)
    expect(trail.filter((e) => e.type === 'DEPOSIT_CAPTURED')).toHaveLength(1)
    expect(trail.filter((e) => e.type === 'AUTHORIZATION_HELD')).toHaveLength(1)
    expect(trail.filter((e) => e.type === 'BOOKING_CONFIRMED')).toHaveLength(1)
    expect(trail.filter((e) => e.type === 'POLICY_ACKNOWLEDGED')).toHaveLength(1)

    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
  })

  it('charge_no_show: N simultaneous calls with the same key produce exactly one capture and one NO_SHOW_CHARGED event', async () => {
    clock.set(new Date(slotAt('10:00').getTime() - 2 * 3_600_000))
    const { bookingId, startsAt } = await holdAndConfirm('10:00')
    clock.set(new Date(startsAt.getTime() + 16 * 60_000))
    await markNoShow({ bookingId, idempotencyKey: freshKey() }, deps)

    const key = freshKey()
    const N = 6
    const results = await Promise.all(Array.from({ length: N }, () => chargeNoShow({ bookingId, idempotencyKey: key }, deps)))

    const paymentIds = new Set(results.map((r) => r.charge.paymentId))
    expect(paymentIds.size).toBe(1)

    const trail = await loadEventLog(bookingId)
    expect(trail.filter((e) => e.type === 'NO_SHOW_CHARGED')).toHaveLength(1)

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('NO_SHOW_CHARGED')
  })

  it('cancel: N simultaneous calls with the same key produce exactly one refund and one set of cancellation events', async () => {
    clock.set(new Date(slotAt('11:00').getTime() - 72 * 3_600_000))
    const { bookingId } = await holdAndConfirm('11:00')
    // Still >48h out at cancel time (0% retention tier) — a real refund is issued, not skipped.
    clock.set(new Date(slotAt('11:00').getTime() - 60 * 3_600_000))

    const key = freshKey()
    const N = 6
    const results = await Promise.all(Array.from({ length: N }, () => cancelBooking({ bookingId, idempotencyKey: key }, deps)))

    const refundIds = new Set(results.map((r) => r.refund.refundId))
    expect(refundIds.size).toBe(1)
    for (const r of results) {
      expect(r.retained.amountPaise).toBe(0)
      expect(r.refund.amountPaise).toBeGreaterThan(0)
    }

    const trail = await loadEventLog(bookingId)
    expect(trail.filter((e) => e.type === 'CANCELLED_BY_CUSTOMER')).toHaveLength(1)
    expect(trail.filter((e) => e.type === 'REFUND_ISSUED')).toHaveLength(1)
    expect(trail.filter((e) => e.type === 'AUTHORIZATION_RELEASED')).toHaveLength(1)

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('CANCELLED_BY_CUSTOMER')
  })
})

describe('IDEMPOTENT_REPLAY (docs/03-domain-model.md §5)', () => {
  const claimedKeysToRelease: Array<{ scope: string; key: string }> = []

  afterEach(async () => {
    for (const { scope, key } of claimedKeysToRelease.splice(0)) {
      await deps.idempotencyStore.release(scope, key)
    }
  })

  it('a request whose identical in-flight twin never completes is refused IDEMPOTENT_REPLAY, and it lands in the trail', async () => {
    clock.set(new Date(slotAt('12:00').getTime() - 72 * 3_600_000))
    const { bookingId } = await holdAndConfirm('12:00')
    clock.set(new Date(slotAt('12:00').getTime() - 60 * 3_600_000))

    const key = freshKey()
    // Claim the key ourselves and never complete it — simulates a first
    // attempt that is still genuinely in flight (or crashed after claiming
    // but before finishing) when a second, identical request arrives.
    const claim = await deps.idempotencyStore.claim('cancel', key)
    expect(claim.kind).toBe('claimed')
    claimedKeysToRelease.push({ scope: 'cancel', key })

    const shortTimeoutDeps: AppDeps = { ...deps, idempotencyClaimTimeoutMs: 200 }
    await expect(cancelBooking({ bookingId, idempotencyKey: key }, shortTimeoutDeps)).rejects.toMatchObject({ code: 'IDEMPOTENT_REPLAY' })

    const trail = await loadEventLog(bookingId)
    const refusal = trail.find((e) => e.type === 'ACTION_REFUSED')
    expect(refusal).toMatchObject({ refusalCode: 'IDEMPOTENT_REPLAY', attemptedType: 'cancel' })

    // Never touched — the booking is exactly as it was before the timed-out retry.
    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
  })

  it('once the original claim releases (the failure path), the key becomes retryable again — a failed attempt is never stuck forever', async () => {
    clock.set(new Date(slotAt('13:00').getTime() - 72 * 3_600_000))
    const { bookingId } = await holdAndConfirm('13:00')
    clock.set(new Date(slotAt('13:00').getTime() - 60 * 3_600_000))

    const key = freshKey()
    const claim = await deps.idempotencyStore.claim('cancel', key)
    expect(claim.kind).toBe('claimed')
    await deps.idempotencyStore.release('cancel', key)

    // The exact same key, retried after the original claimant released it
    // (e.g. it failed before completing) — must run for real, not refuse.
    const result = await cancelBooking({ bookingId, idempotencyKey: key }, deps)
    expect(result.status).toBe('CANCELLED_BY_CUSTOMER')
  })
})

describe('POLICY_VERSION_STALE (docs/03-domain-model.md §5)', () => {
  const STALE_TEST_POLICY_VERSION = 999

  afterAll(async () => {
    await deletePoliciesForTest(db, eq(policies.version, STALE_TEST_POLICY_VERSION))
  })

  it('refuses confirm_with_deposit when the acknowledged version is not the merchant\'s current one, and records it', async () => {
    clock.set(new Date(slotAt('14:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('14:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    const currentPolicy = await getPolicy(deps)

    // Publish a newer policy version — same numbers, just a version bump —
    // so `currentPolicy.policyVersion` (what the agent acknowledged a
    // moment ago) is now stale.
    await db.insert(policies).values({
      policyId: `pol_test_stale_${ulid()}`,
      merchantId: SEED_MERCHANT_ID,
      version: STALE_TEST_POLICY_VERSION,
      depositType: 'fixed',
      depositAmountPaise: currentPolicy.policy.depositAmountPaise,
      cancellationLadder: [
        { hoursBefore: 48, retainPct: 0 },
        { hoursBefore: 12, retainPct: 50 },
        { hoursBefore: 0, retainPct: 100 },
      ],
      noShowFeePaise: currentPolicy.policy.noShowFeePaise ?? null,
      noShowGraceMinutes: 15,
      holdTtlSeconds: currentPolicy.policy.holdTtlSeconds,
      maxConcurrentHoldsPerAgent: currentPolicy.policy.maxConcurrentHoldsPerAgent,
      createdAt: new Date(),
    })

    await expect(
      confirmWithDeposit(
        { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: currentPolicy.policy.policyVersion, idempotencyKey: freshKey() },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'POLICY_VERSION_STALE' })

    const trail = await loadEventLog(held.bookingId)
    expect(trail.find((e) => e.type === 'ACTION_REFUSED')).toMatchObject({ refusalCode: 'POLICY_VERSION_STALE' })

    // The hold is untouched — a refused confirm never flips state.
    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('HELD')

    // With the correct, current version acknowledged, it goes through.
    const confirmed = await confirmWithDeposit(
      { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: STALE_TEST_POLICY_VERSION, idempotencyKey: freshKey() },
      deps,
    )
    expect(confirmed.status).toBe('CONFIRMED')
  })
})
