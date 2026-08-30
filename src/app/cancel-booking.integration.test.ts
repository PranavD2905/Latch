import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createNoopLogger } from '../adapters/observability/noop-logger.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { PostgresWebhookDeadLetterStore } from '../adapters/db/postgres-webhook-dead-letter-store.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../adapters/db/seed-data.js'
import { bookings, events } from '../adapters/db/schema.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import type { BookingEvent } from '../domain/events.js'
import { runAuthorizationLapseWorker } from './authorization-lapse-worker.js'
import { BookingNotCancellableError, type CancelBookingCommand, cancelBooking } from './cancel-booking.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { requireConfirmed } from './confirm-with-deposit-test-support.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import type { AppDeps } from './types.js'

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))
const paymentProvider = new FakePaymentProvider()

const deps: AppDeps = {
  clock,
  logger: createNoopLogger(),
  paymentCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider,
  paymentRail: new FakePaymentRail(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
  merchantId: SEED_MERCHANT_ID,
}

// Wednesday 2026-09-16, a day this suite doesn't share with any other integration suite.
const BASE_DAY = '2026-09-16'
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

async function holdAndConfirm(hhmm: string): Promise<{ bookingId: string; startsAt: Date; depositAmountPaise: number; authorizationId: string }> {
  const startsAt = slotAt(hhmm)
  const agentId = `agent_${ulid()}`
  const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
  createdBookingIds.push(held.bookingId)
  const policyResult = await getPolicy(deps)
  const confirmed = requireConfirmed(
    await confirmWithDeposit(
      { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() },
      deps,
    ),
  )
  return { bookingId: held.bookingId, startsAt, depositAmountPaise: confirmed.deposit!.amountPaise, authorizationId: confirmed.authorization!.authorizationId }
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

describe('cancel (real Postgres + FakePaymentProvider + FrozenClock) — the customer-caused, ladder-applying path', () => {
  it('cancelling at 72h before the appointment refunds in full (0% tier)', async () => {
    clock.set(new Date(slotAt('09:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId, depositAmountPaise, authorizationId } = await holdAndConfirm('09:00')

    clock.set(new Date(slotAt('09:00').getTime() - 72 * 3_600_000))
    const cancelled = await cancelBooking({ bookingId, idempotencyKey: freshKey() }, deps)

    expect(cancelled.status).toBe('CANCELLED_BY_CUSTOMER')
    expect(cancelled.retained.amountPaise).toBe(0)
    expect(cancelled.refund.amountPaise).toBe(depositAmountPaise)
    expect(cancelled.refund.refundId).toBeDefined()

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('CANCELLED_BY_CUSTOMER')

    const allEvents = await loadEventLog(bookingId)
    const trailing = allEvents.slice(-4).map((e) => e.type)
    // This task: cancel_booking now also releases the session-complete
    // mandate (a cancelled booking's session will never complete either) —
    // one more trailing event than before.
    expect(trailing).toEqual(['CANCELLED_BY_CUSTOMER', 'REFUND_ISSUED', 'AUTHORIZATION_RELEASED', 'SESSION_COMPLETE_AUTHORIZATION_RELEASED']) // no RETENTION_APPLIED — 0% retained
    expect(allEvents.some((e) => e.type === 'RETENTION_APPLIED')).toBe(false)

    const released = allEvents.find((e) => e.type === 'AUTHORIZATION_RELEASED')
    expect(released).toMatchObject({ authorizationId })

    // The slot is free again.
    const rebooked = await holdSlot(
      { agentId: `agent_${ulid()}`, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:00'), idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(rebooked.bookingId)
    expect(rebooked.status).toBe('HELD')
  })

  it('cancelling at 47h59m before the appointment retains 50%, refunds the remainder', async () => {
    clock.set(new Date(slotAt('10:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId, depositAmountPaise } = await holdAndConfirm('10:00')

    clock.set(new Date(slotAt('10:00').getTime() - (47 * 3_600_000 + 59 * 60_000)))
    const cancelled = await cancelBooking({ bookingId, idempotencyKey: freshKey() }, deps)

    expect(cancelled.retained.amountPaise).toBe(Math.floor(depositAmountPaise * 0.5))
    expect(cancelled.refund.amountPaise).toBe(depositAmountPaise - cancelled.retained.amountPaise)
    expect(cancelled.retained.amountPaise + cancelled.refund.amountPaise).toBe(depositAmountPaise) // the two halves always sum to exactly the deposit

    const allEvents = await loadEventLog(bookingId)
    expect(allEvents.some((e) => e.type === 'RETENTION_APPLIED')).toBe(true)
    expect(allEvents.some((e) => e.type === 'REFUND_ISSUED')).toBe(true)
  })

  it('cancelling at 11h59m before the appointment retains 100%, refunds nothing', async () => {
    clock.set(new Date(slotAt('11:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId, depositAmountPaise } = await holdAndConfirm('11:00')

    clock.set(new Date(slotAt('11:00').getTime() - (11 * 3_600_000 + 59 * 60_000)))
    const cancelled = await cancelBooking({ bookingId, idempotencyKey: freshKey() }, deps)

    expect(cancelled.retained.amountPaise).toBe(depositAmountPaise)
    expect(cancelled.refund.amountPaise).toBe(0)
    expect(cancelled.refund.refundId).toBeUndefined() // no Razorpay refund of ₹0 was ever attempted

    const allEvents = await loadEventLog(bookingId)
    expect(allEvents.some((e) => e.type === 'RETENTION_APPLIED')).toBe(true)
    expect(allEvents.some((e) => e.type === 'REFUND_ISSUED')).toBe(false) // nothing to refund — no event for it
  })

  it('an already-started appointment (negative hoursUntil) still retains 100%, via the ladder catch-all tier', async () => {
    clock.set(new Date(slotAt('12:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId, depositAmountPaise } = await holdAndConfirm('12:00')

    clock.set(new Date(slotAt('12:00').getTime() + 2 * 3_600_000)) // 2h after the appointment started
    const cancelled = await cancelBooking({ bookingId, idempotencyKey: freshKey() }, deps)

    expect(cancelled.retained.amountPaise).toBe(depositAmountPaise)
    expect(cancelled.refund.amountPaise).toBe(0)
  })

  it('the ladder tier comes from the server clock alone — a claimed timestamp on the command has no effect (there is no such field to pass)', async () => {
    clock.set(new Date(slotAt('13:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId, depositAmountPaise } = await holdAndConfirm('13:00')

    clock.set(new Date(slotAt('13:00').getTime() - 72 * 3_600_000)) // free-tier position
    // CancelBookingCommand has no time-related field at all — this is the
    // compile-time guarantee (docs/01-architecture.md §5). Casting through
    // `unknown` to attach a bogus claimed timestamp anyway, to prove even a
    // caller that tried to smuggle one in is simply ignored: the result
    // still reflects the server clock's real position (0% retained), not
    // whatever `claimedNow` says.
    const forged = { bookingId, idempotencyKey: freshKey(), claimedNow: slotAt('13:00').toISOString() } as unknown as CancelBookingCommand
    const cancelled = await cancelBooking(forged, deps)

    expect(cancelled.retained.amountPaise).toBe(0)
    expect(cancelled.refund.amountPaise).toBe(depositAmountPaise)
  })

  it('refuses to cancel a booking that is not CONFIRMED (still HELD)', async () => {
    clock.set(new Date(slotAt('14:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('14:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    await expect(cancelBooking({ bookingId: held.bookingId, idempotencyKey: freshKey() }, deps)).rejects.toBeInstanceOf(BookingNotCancellableError)
  })

  it('is idempotent: replaying the same cancel key does not issue a second refund', async () => {
    clock.set(new Date(slotAt('15:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId } = await holdAndConfirm('15:00')
    clock.set(new Date(slotAt('15:00').getTime() - 72 * 3_600_000))

    const key = freshKey()
    const first = await cancelBooking({ bookingId, idempotencyKey: key }, deps)
    const second = await cancelBooking({ bookingId, idempotencyKey: key }, deps)

    expect(second.refund.refundId).toBe(first.refund.refundId)
    const allEvents = await loadEventLog(bookingId)
    expect(allEvents.filter((e) => e.type === 'REFUND_ISSUED')).toHaveLength(1)
  })

  it('if the authorisation already lapsed, cancel does not re-release it — no second AUTHORIZATION_RELEASED-equivalent event', async () => {
    // Confirmed 10 days out: the 5-day authorisation window (expiresAt =
    // confirm time + 5d) lapses at appointment-minus-5-days, well before the
    // 48h free-tier boundary this test also wants to land in.
    clock.set(new Date(slotAt('16:00').getTime() - 10 * 24 * 3_600_000))
    const { bookingId } = await holdAndConfirm('16:00')

    // After the authorisation has lapsed (appointment-minus-5d), but still
    // comfortably inside the ladder's free tier (appointment-minus-4d ≥ 48h).
    clock.set(new Date(slotAt('16:00').getTime() - 4 * 24 * 3_600_000))
    const { lapsedBookingIds } = await runAuthorizationLapseWorker(deps)
    expect(lapsedBookingIds).toContain(bookingId)

    const cancelled = await cancelBooking({ bookingId, idempotencyKey: freshKey() }, deps)
    expect(cancelled.status).toBe('CANCELLED_BY_CUSTOMER')

    const allEvents = await loadEventLog(bookingId)
    expect(allEvents.filter((e) => e.type === 'AUTHORIZATION_RELEASED')).toHaveLength(0)
    expect(allEvents.filter((e) => e.type === 'AUTHORIZATION_LAPSED')).toHaveLength(1) // still exactly the one the worker recorded
  })
})
