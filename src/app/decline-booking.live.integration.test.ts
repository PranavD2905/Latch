import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
import { bookings, events, idempotencyKeys } from '../adapters/db/schema.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../adapters/db/seed-data.js'
import { RazorpayPaymentProvider } from '../adapters/payment/razorpay-payment-provider.js'
import { createBookingConfirmedEvent, createDepositCapturedEvent, createHoldCreatedEvent, createPolicyAcknowledgedEvent } from '../domain/event-factory.js'
import { toPaise } from '../domain/money.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { declineBooking } from './decline-booking.js'
import type { AppDeps } from './types.js'

/**
 * Hits real Razorpay test mode for the refund leg — no mocking, same
 * convention as razorpay-payment-provider.live.integration.test.ts.
 *
 * The full hold -> confirm -> decline flow cannot run against Razorpay from
 * a fresh state in this suite: `confirm_with_deposit` against the real
 * provider only completes once a human finishes Checkout
 * (dev-logs/006/007), and this is an unattended test run. So this test
 * seeds a CONFIRMED booking's event history directly (HOLD_CREATED ->
 * POLICY_ACKNOWLEDGED -> DEPOSIT_CAPTURED -> BOOKING_CONFIRMED, the exact
 * shape confirm_with_deposit itself writes) pointing at a *real* Razorpay
 * payment already on record — `pay_TTFUhHVTQOyr0o`, the refund-idempotency
 * fixture dev-logs/006 established. That payment is already refunded in
 * full via receipt `latch-live-test-refund-key` (verified live before
 * writing this test: status "refunded", amount_refunded 30000). Calling
 * declineBooking with that same idempotency key exercises the real
 * `refundDeposit` -> `payments.fetchMultipleRefund` lookup against
 * Razorpay's live API — genuinely proving "the refund exists at Razorpay,"
 * not just in our own log — without mutating that payment further or
 * needing a fresh human Checkout. See dev-logs/006 for why no fresh
 * capture-then-refund fixture is created here: this project's convention is
 * never to refund the "keeper" fixture, and every other existing fixture is
 * either already fully refunded (this one) or must stay captured forever.
 */

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const keyId = process.env['RAZORPAY_KEY_ID']
const keySecret = process.env['RAZORPAY_KEY_SECRET']

const { sql, db } = createDbClient(databaseUrl)
const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))

const REFUND_FIXTURE_PAYMENT_ID = 'pay_TTFUhHVTQOyr0o'
const REFUND_IDEMPOTENCY_KEY = 'latch-live-test-refund-key'
const KNOWN_REFUND_ID = 'rfnd_TTFbG2lqrZOatR'
const DEPOSIT_AMOUNT_PAISE = toPaise(30000)

const createdBookingIds: string[] = []

beforeAll(async () => {
  if (!keyId || !keySecret) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set — see razorpay-payment-provider.live.integration.test.ts for why this cannot be mocked.')
  }
  const catalogRepo = new PostgresCatalogRepo(db)
  const policy = await catalogRepo.getActivePolicy(SEED_MERCHANT_ID)
  if (!policy) {
    throw new Error('seed data missing — run `npm run db:seed` before this test suite (declineBooking calls find_slots for alternatives, which reads the catalog)')
  }
  // This test deliberately reuses the same idempotency key every run (see
  // the file-level comment: it must resolve to the one already-refunded
  // Razorpay fixture, not attempt a fresh refund). Our *own* idempotency
  // cache is keyed only on (scope, key) — not bookingId — so a stale row
  // from a previous run would short-circuit declineBooking before it ever
  // touched this run's fresh booking, silently passing while doing nothing.
  // Clearing it here makes each run exercise the real declineBooking path
  // and the real Razorpay receipt lookup, not a cached local response.
  await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.scope, 'decline_booking'), eq(idempotencyKeys.key, REFUND_IDEMPOTENCY_KEY)))
})

afterAll(async () => {
  for (const bookingId of createdBookingIds) {
    await db.delete(events).where(eq(events.bookingId, bookingId))
    await db.delete(bookings).where(eq(bookings.bookingId, bookingId))
  }
  await sql.end()
})

describe('decline_booking against real Razorpay test mode', () => {
  it('refunds via the real Razorpay API and resolves to the known, already-refunded fixture', async () => {
    const deps: AppDeps = {
      clock,
      eventStore: new PostgresEventStore(db),
      catalogRepo: new PostgresCatalogRepo(db),
      paymentProvider: new RazorpayPaymentProvider({ keyId: keyId!, keySecret: keySecret! }),
      idempotencyStore: new PostgresIdempotencyStore(db),
      merchantId: SEED_MERCHANT_ID,
    }

    const bookingId = `bkg_livedecline_${ulid()}`
    const startsAt = new Date('2026-09-17T09:00:00+05:30')
    createdBookingIds.push(bookingId)

    await deps.eventStore.transaction(async (tx) => {
      const holdEvent = createHoldCreatedEvent(bookingId, 1, clock, {
        practitionerId: SEED_PRACTITIONER_ID,
        serviceId: SEED_SERVICE_ID,
        startsAt,
        ttlSeconds: 600,
      })
      const ackEvent = createPolicyAcknowledgedEvent(bookingId, 2, clock, { policyVersion: 1 })
      const depositEvent = createDepositCapturedEvent(bookingId, 3, clock, {
        action: { direction: 'credit', amountPaise: DEPOSIT_AMOUNT_PAISE, instrument: 'card' },
        gate: { cleared: ['live_hold', 'policy_acked'], evidence: {} },
        bound: { ceilingPaise: DEPOSIT_AMOUNT_PAISE, enforcedBy: 'latch_policy', headroomAfterPaise: toPaise(0) },
        authority: { policyVersion: 1, razorpayPaymentId: REFUND_FIXTURE_PAYMENT_ID },
      })
      const confirmedEvent = createBookingConfirmedEvent(bookingId, 4, clock, {})

      const projection: BookingSnapshot = {
        bookingId,
        practitionerId: SEED_PRACTITIONER_ID,
        serviceId: SEED_SERVICE_ID,
        startsAt,
        status: 'CONFIRMED',
        policyVersion: 1,
        mandateId: undefined,
        agentId: 'agent_live_decline_seed',
        holdExpiresAt: undefined,
        lastEventSequence: 4,
      }
      await tx.append([holdEvent, ackEvent, depositEvent, confirmedEvent], projection)
    })

    const declined = await declineBooking({ bookingId, reason: 'practitioner_unavailable', idempotencyKey: REFUND_IDEMPOTENCY_KEY }, deps)

    expect(declined.status).toBe('DECLINED_BY_MERCHANT')
    expect(declined.refund.refundId).toBe(KNOWN_REFUND_ID) // the real Razorpay refund id, verified live
    expect(declined.refund.amountPaise).toBe(30000) // full ₹300 deposit, net customer cost ₹0

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('DECLINED_BY_MERCHANT')
  }, 20_000)
})
