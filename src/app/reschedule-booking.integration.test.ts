import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
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
import { cancelBooking } from './cancel-booking.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import { BookingNotFoundError, BookingNotReschedulableError, rescheduleBooking } from './reschedule-booking.js'
import type { AppDeps } from './types.js'

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))
const paymentProvider = new FakePaymentProvider()

const deps: AppDeps = {
  clock,
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider,
  paymentRail: new FakePaymentRail(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
  merchantId: SEED_MERCHANT_ID,
}

// Thursday 2026-09-17, a day this suite doesn't share with any other integration suite.
const BASE_DAY = '2026-09-17'
// The next Thursday, for "move it into next month" style targets.
const FAR_DAY = '2026-10-15'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}
function farSlotAt(hhmm: string): Date {
  return new Date(`${FAR_DAY}T${hhmm}:00+05:30`)
}

const createdBookingIds: string[] = []
function freshKey(): string {
  return `test_${ulid()}`
}

async function loadEventLog(bookingId: string): Promise<readonly BookingEvent[]> {
  const rows = await db.select().from(events).where(eq(events.bookingId, bookingId)).orderBy(events.sequence)
  return rows.map((row) => row.payload as BookingEvent)
}

async function holdAndConfirm(startsAt: Date): Promise<{ bookingId: string; agentId: string; depositAmountPaise: number; authorizationId: string }> {
  const agentId = `agent_${ulid()}`
  const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
  createdBookingIds.push(held.bookingId)
  const policyResult = await getPolicy(deps)
  const confirmed = await confirmWithDeposit(
    { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() },
    deps,
  )
  return { bookingId: held.bookingId, agentId, depositAmountPaise: confirmed.deposit.amountPaise, authorizationId: confirmed.authorization!.authorizationId }
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

describe('reschedule (real Postgres + FakePaymentProvider + FrozenClock) — a self-transition, not a cancel-and-rebook', () => {
  it('moves a confirmed booking in the free tier: same bookingId, deposit, and authorization; new startsAt', async () => {
    clock.set(new Date(slotAt('09:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId, authorizationId } = await holdAndConfirm(slotAt('09:00'))

    clock.set(new Date(slotAt('09:00').getTime() - 72 * 3_600_000)) // well inside the free (0%) tier
    const newStartsAt = slotAt('11:00')
    const result = await rescheduleBooking({ bookingId, newStartsAt, idempotencyKey: freshKey() }, deps)

    expect(result.status).toBe('CONFIRMED')
    expect(result.bookingId).toBe(bookingId)
    expect(result.previousStartsAt).toBe(slotAt('09:00').toISOString())
    expect(result.startsAt).toBe(newStartsAt.toISOString())

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
    expect(snapshot?.startsAt.toISOString()).toBe(newStartsAt.toISOString())
    expect(snapshot?.authorizationId).toBe(authorizationId) // same authorisation, untouched

    const allEvents = await loadEventLog(bookingId)
    expect(allEvents.some((e) => e.type === 'DEPOSIT_CAPTURED')).toBe(true)
    expect(allEvents.filter((e) => e.type === 'DEPOSIT_CAPTURED')).toHaveLength(1) // no second deposit — same money
    expect(allEvents.filter((e) => e.type === 'AUTHORIZATION_HELD')).toHaveLength(1) // no second authorisation
    const rescheduled = allEvents.find((e) => e.type === 'BOOKING_RESCHEDULED')
    expect(rescheduled).toMatchObject({
      previousStartsAt: slotAt('09:00').toISOString(),
      newStartsAt: newStartsAt.toISOString(),
      priceDeltaPaise: 0,
    })

    // The old slot is free again.
    const rebooked = await holdSlot(
      { agentId: `agent_${ulid()}`, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:00'), idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(rebooked.bookingId)
    expect(rebooked.status).toBe('HELD')
  })

  it('refuses LADDER_FORBIDS_MOVE inside the 50% tier — too close in to move, cancel instead', async () => {
    clock.set(new Date(slotAt('12:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId } = await holdAndConfirm(slotAt('12:00'))

    clock.set(new Date(slotAt('12:00').getTime() - 24 * 3_600_000)) // inside the 12-48h / 50% tier
    await expect(rescheduleBooking({ bookingId, newStartsAt: slotAt('14:00'), idempotencyKey: freshKey() }, deps)).rejects.toMatchObject({
      code: 'LADDER_FORBIDS_MOVE',
    })

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.startsAt.toISOString()).toBe(slotAt('12:00').toISOString()) // never moved

    const allEvents = await loadEventLog(bookingId)
    const refusal = allEvents.find((e) => e.type === 'ACTION_REFUSED')
    expect(refusal).toMatchObject({ attemptedType: 'reschedule', refusalCode: 'LADDER_FORBIDS_MOVE' })
  })

  it('refuses LADDER_FORBIDS_MOVE inside the 100% tier', async () => {
    clock.set(new Date(slotAt('13:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId } = await holdAndConfirm(slotAt('13:00'))

    clock.set(new Date(slotAt('13:00').getTime() - 6 * 3_600_000)) // inside the <12h / 100% tier
    await expect(rescheduleBooking({ bookingId, newStartsAt: slotAt('15:00'), idempotencyKey: freshKey() }, deps)).rejects.toMatchObject({
      code: 'LADDER_FORBIDS_MOVE',
    })
  })

  it('the reschedule-then-cancel dodge is refused: cannot move out of the 100% tier to cancel for free from there', async () => {
    clock.set(new Date(slotAt('16:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId, depositAmountPaise } = await holdAndConfirm(slotAt('16:00'))

    clock.set(new Date(slotAt('16:00').getTime() - 6 * 3_600_000)) // deep in the 100% tier
    await expect(
      rescheduleBooking({ bookingId, newStartsAt: farSlotAt('10:00'), idempotencyKey: freshKey() }, deps),
    ).rejects.toMatchObject({ code: 'LADDER_FORBIDS_MOVE' })

    // The booking never moved — cancelling from the same (still 100%-tier)
    // position retains the full deposit, exactly as it would have without
    // the reschedule attempt. There is no way to have reached farSlotAt from here.
    const cancelled = await cancelBooking({ bookingId, idempotencyKey: freshKey() }, deps)
    expect(cancelled.retained.amountPaise).toBe(depositAmountPaise)
    expect(cancelled.refund.amountPaise).toBe(0)
  })

  it('refuses SLOT_TAKEN when the target slot already has another live booking', async () => {
    clock.set(new Date(slotAt('17:00').getTime() - 5 * 24 * 3_600_000))
    const a = await holdAndConfirm(slotAt('17:00'))
    const b = await holdAndConfirm(slotAt('18:00'))

    clock.set(new Date(slotAt('17:00').getTime() - 72 * 3_600_000)) // free tier for both
    await expect(rescheduleBooking({ bookingId: a.bookingId, newStartsAt: slotAt('18:00'), idempotencyKey: freshKey() }, deps)).rejects.toMatchObject({
      code: 'SLOT_TAKEN',
    })

    const snapshotA = await deps.eventStore.loadSnapshot(a.bookingId)
    expect(snapshotA?.startsAt.toISOString()).toBe(slotAt('17:00').toISOString()) // A never moved
    const snapshotB = await deps.eventStore.loadSnapshot(b.bookingId)
    expect(snapshotB?.startsAt.toISOString()).toBe(slotAt('18:00').toISOString()) // B untouched

    const allEventsA = await loadEventLog(a.bookingId)
    const refusal = allEventsA.find((e) => e.type === 'ACTION_REFUSED')
    expect(refusal).toMatchObject({ attemptedType: 'reschedule', refusalCode: 'SLOT_TAKEN' })
  })

  it('refuses to reschedule a booking that is not CONFIRMED (still HELD)', async () => {
    clock.set(new Date(slotAt('19:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('19:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    await expect(rescheduleBooking({ bookingId: held.bookingId, newStartsAt: slotAt('20:00'), idempotencyKey: freshKey() }, deps)).rejects.toBeInstanceOf(
      BookingNotReschedulableError,
    )
  })

  it('404s on an unknown booking', async () => {
    await expect(rescheduleBooking({ bookingId: `bkg_${ulid()}`, newStartsAt: slotAt('21:00'), idempotencyKey: freshKey() }, deps)).rejects.toBeInstanceOf(
      BookingNotFoundError,
    )
  })

  it('is idempotent: replaying the same reschedule key does not move it twice', async () => {
    clock.set(new Date(slotAt('22:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId } = await holdAndConfirm(slotAt('22:00'))
    clock.set(new Date(slotAt('22:00').getTime() - 72 * 3_600_000))

    const key = freshKey()
    const newStartsAt = slotAt('23:00')
    const first = await rescheduleBooking({ bookingId, newStartsAt, idempotencyKey: key }, deps)
    const second = await rescheduleBooking({ bookingId, newStartsAt, idempotencyKey: key }, deps)

    expect(second).toEqual(first)
    const allEvents = await loadEventLog(bookingId)
    expect(allEvents.filter((e) => e.type === 'BOOKING_RESCHEDULED')).toHaveLength(1)
  })
})
