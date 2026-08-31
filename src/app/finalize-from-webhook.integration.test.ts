import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toPaise } from '../domain/money.js'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createNoopLogger } from '../adapters/observability/noop-logger.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { PostgresWebhookDeadLetterStore } from '../adapters/db/postgres-webhook-dead-letter-store.js'
import { bookings, events } from '../adapters/db/schema.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../adapters/db/seed-data.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import type { PaymentProvider } from '../ports/payment-provider.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { requireConfirmed } from './confirm-with-deposit-test-support.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import { finalizeFromWebhook } from './finalize-from-webhook.js'
import type { AppDeps } from './types.js'

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))
const paymentProvider = new FakePaymentProvider()
const paymentRail = new FakePaymentRail()

const deps: AppDeps = {
  clock,
  logger: createNoopLogger(),
  paymentCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider,
  paymentRail,
  idempotencyStore: new PostgresIdempotencyStore(db),
  reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
  merchantId: SEED_MERCHANT_ID,
}

// Saturday 2026-09-19, a day no other integration-test file books against.
const BASE_DAY = '2026-09-19'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}
function freshKey(): string {
  return `test_${ulid()}`
}

const createdBookingIds: string[] = []

beforeAll(async () => {
  const policy = await deps.catalogRepo.getActivePolicy(SEED_MERCHANT_ID)
  if (!policy) {
    throw new Error('seed data missing — run `npm run db:seed` before this test suite')
  }

  // Self-healing setup, not just cleanup. These tests book fixed slots on a
  // fixed day, so anything this file left behind — an interrupted run, a
  // failed assertion before `afterAll`, two runs against the same shared
  // cluster — makes the next run fail with SLOT_TAKEN on a booking that has
  // nothing to do with what is being tested. Clearing this file's own day up
  // front means a dirty database cannot masquerade as a broken feature.
  const stale = await db.select({ bookingId: bookings.bookingId }).from(bookings).where(eq(bookings.practitionerId, SEED_PRACTITIONER_ID))
  for (const row of stale) {
    const snapshot = await deps.eventStore.loadSnapshot(row.bookingId)
    if (snapshot && snapshot.startsAt >= slotAt('00:00') && snapshot.startsAt < slotAt('23:59')) {
      await db.delete(events).where(eq(events.bookingId, row.bookingId))
      await db.delete(bookings).where(eq(bookings.bookingId, row.bookingId))
    }
  }
})

afterAll(async () => {
  for (const bookingId of createdBookingIds) {
    await db.delete(events).where(eq(events.bookingId, bookingId))
    await db.delete(bookings).where(eq(bookings.bookingId, bookingId))
  }
  await sql.end()
})

describe('webhook-driven finalization (real Postgres) — dev-logs/031', () => {
  it('finalizes a fully-paid booking from the webhook, so an unpaid conversation cannot strand real money', async () => {
    // dev-logs/031, the production incident this exists to prevent: the
    // customer paid every leg, never told the agent, and the hold-expiry
    // worker reclaimed the slot five minutes later exactly as designed —
    // leaving real money captured/authorised against an EXPIRED booking.
    // Finalization must not depend on the customer remembering to speak.
    const startsAt = slotAt('12:30')
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    const confirmKey = freshKey()
    paymentProvider.setScenario(confirmKey, 'pending')
    const pending = await confirmWithDeposit(
      { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: (await getPolicy(deps)).policy.policyVersion, idempotencyKey: confirmKey },
      deps,
    )
    expect(pending.status).toBe('PENDING')

    const before = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(before?.status).toBe('HELD')
    const paidLeg = before?.pendingPaymentLegs?.[0]
    expect(paidLeg).toBeDefined()

    // The customer completes every leg at Checkout. The fakes key their state
    // by the *original* confirm's idempotencyKey, exactly as the real
    // adapters resolve an order back to the receipt that created it.
    paymentProvider.completeDeposit(confirmKey)
    paymentRail.completeAuthorization(`${confirmKey}:session_complete_auth`)

    // Razorpay tells us. The agent is never involved.
    const { finalized } = await finalizeFromWebhook(held.bookingId, paidLeg!.orderId, deps)
    expect(finalized).toBe(true)

    const after = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(after?.status).toBe('CONFIRMED')
    // The slot is now held by a CONFIRMED booking, so the hold-expiry
    // worker's `status='held'` claim can never reach it again.
    expect(after?.pendingPaymentLegs ?? []).toHaveLength(0)
  })

  it('ignores a webhook for an order this booking never issued, and never resurrects a settled booking', async () => {
    const startsAt = slotAt('13:30')
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)
    requireConfirmed(
      await confirmWithDeposit(
        { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: (await getPolicy(deps)).policy.policyVersion, idempotencyKey: freshKey() },
        deps,
      ),
    )

    // Wrong order: not one of this booking's legs.
    expect((await finalizeFromWebhook(held.bookingId, 'order_never_issued_here', deps)).finalized).toBe(false)

    // Already CONFIRMED: settled, nothing to finalize. An EXPIRED or
    // CANCELLED booking is likewise left alone — a late webhook must not
    // resurrect it; that is reconciliation's to report, not ours to hide.
    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
  })
})
