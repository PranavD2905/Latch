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
import { createMerchantDeclinedEvent, createRefundIssuedEvent, createSlotReleasedEvent } from '../domain/event-factory.js'
import type { BookingEvent } from '../domain/events.js'
import { toPaise } from '../domain/money.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { BookingNotDeclinableError, declineBooking } from './decline-booking.js'
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

// Wednesday 2026-09-09, a day this suite doesn't share with booking-flow.integration.test.ts.
const BASE_DAY = '2026-09-09'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}

const createdBookingIds: string[] = []
function freshKey(): string {
  return `test_${ulid()}`
}

/** Raw event-log read, ordered by sequence — `EventStore` intentionally exposes `loadEvents` only inside a transaction (`EventStoreTx`); a plain read here goes straight at the table, same as booking-flow.integration.test.ts does. */
async function loadEventLog(bookingId: string): Promise<readonly BookingEvent[]> {
  const rows = await db.select().from(events).where(eq(events.bookingId, bookingId)).orderBy(events.sequence)
  return rows.map((row) => row.payload as BookingEvent)
}

async function holdAndConfirm(hhmm: string): Promise<{ bookingId: string; startsAt: Date; depositAmountPaise: number }> {
  const startsAt = slotAt(hhmm)
  const agentId = `agent_${ulid()}`
  const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
  createdBookingIds.push(held.bookingId)
  const policyResult = await getPolicy(deps)
  const confirmed = await confirmWithDeposit(
    { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() },
    deps,
  )
  return { bookingId: held.bookingId, startsAt, depositAmountPaise: confirmed.deposit.amountPaise }
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

describe('decline_booking (real Postgres + FakePaymentProvider + FrozenClock) — the B5 failure path', () => {
  it('hold -> confirm -> decline: refunds in full, releases the slot, offers alternatives, six events atomically', async () => {
    clock.set(new Date(slotAt('09:00').getTime() - 5 * 24 * 3_600_000)) // 5 days before appointment
    const { bookingId, startsAt, depositAmountPaise } = await holdAndConfirm('09:00')

    clock.set(new Date(startsAt.getTime() - 24 * 3_600_000)) // decline the day before — well inside every ladder tier
    const declined = await declineBooking({ bookingId, reason: 'practitioner_unavailable', idempotencyKey: freshKey() }, deps)

    expect(declined.status).toBe('DECLINED_BY_MERCHANT')
    expect(declined.refund.amountPaise).toBe(depositAmountPaise) // full refund — net customer cost ₹0
    expect(declined.alternatives.length).toBeGreaterThan(0)
    expect(declined.alternatives.length).toBeLessThanOrEqual(3)
    for (const alt of declined.alternatives) {
      expect(alt.practitionerId).toBe(SEED_PRACTITIONER_ID)
      expect(alt.serviceId).toBe(SEED_SERVICE_ID)
      expect(alt.startsAt).not.toBe(startsAt.toISOString()) // never re-offers the exact declined slot
    }

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('DECLINED_BY_MERCHANT')

    // The slot is bookable again: the partial unique index no longer blocks it.
    const rebooked = await holdSlot(
      { agentId: `agent_${ulid()}`, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(rebooked.bookingId)
    expect(rebooked.status).toBe('HELD')

    const allEvents = await loadEventLog(bookingId)
    // This task: decline_booking now also releases the session-complete
    // mandate — six trailing events, not five.
    const trailingSix = allEvents.slice(-6).map((e) => e.type)
    expect(trailingSix).toEqual(['MERCHANT_DECLINED', 'SLOT_RELEASED', 'REFUND_ISSUED', 'AUTHORIZATION_RELEASED', 'SESSION_COMPLETE_AUTHORIZATION_RELEASED', 'ALTERNATIVES_OFFERED'])
    expect(allEvents.some((e) => e.type === 'RETENTION_APPLIED')).toBe(false) // the ladder was never consulted

    const merchantDeclined = allEvents.find((e) => e.type === 'MERCHANT_DECLINED')
    expect(merchantDeclined).toMatchObject({ cause: 'MERCHANT', reason: 'practitioner_unavailable' })

    const refundEvent = allEvents.find((e) => e.type === 'REFUND_ISSUED')
    expect(refundEvent).toMatchObject({ action: { direction: 'debit', amountPaise: depositAmountPaise } })

    // Slice 4, item 5 — the real release, not the Slice 3 stub: the same
    // authorizationId AUTHORIZATION_HELD registered, never captured.
    const authorizationHeldEvent = allEvents.find((e) => e.type === 'AUTHORIZATION_HELD')
    const authorizationReleasedEvent = allEvents.find((e) => e.type === 'AUTHORIZATION_RELEASED')
    expect(authorizationHeldEvent).toMatchObject({ authorizationId: expect.stringMatching(/^pay_/) })
    expect(authorizationReleasedEvent).toMatchObject({
      authorizationId: (authorizationHeldEvent as { authorizationId?: string })?.authorizationId,
      rail: 'manual_capture',
    })
    expect(allEvents.some((e) => e.type === 'NO_SHOW_CHARGED')).toBe(false) // the no-show fee was never captured — customer never debited for it
  })

  it('cause attribution beats proximity: declining 2 hours before the appointment still retains ₹0', async () => {
    clock.set(new Date(slotAt('10:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId, startsAt, depositAmountPaise } = await holdAndConfirm('10:00')

    // A customer cancellation this close in would sit inside the ladder's
    // 100%-retention tier (hoursUntil < 12). A merchant decline must not
    // care — full refund regardless, because cause=MERCHANT never touches
    // the ladder at all (docs/03-domain-model.md §3 Rule 2).
    clock.set(new Date(startsAt.getTime() - 2 * 3_600_000))
    const declined = await declineBooking({ bookingId, reason: 'practitioner_unavailable', idempotencyKey: freshKey() }, deps)

    expect(declined.refund.amountPaise).toBe(depositAmountPaise) // 0 retained, even deep in the 100% tier
  })

  it('refuses to decline a booking that is not CONFIRMED (still HELD)', async () => {
    clock.set(new Date(slotAt('11:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('11:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    await expect(declineBooking({ bookingId: held.bookingId, reason: 'x', idempotencyKey: freshKey() }, deps)).rejects.toBeInstanceOf(
      BookingNotDeclinableError,
    )
  })

  it('is idempotent: replaying the same decline key does not issue a second refund', async () => {
    clock.set(new Date(slotAt('12:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId, startsAt } = await holdAndConfirm('12:00')
    clock.set(new Date(startsAt.getTime() - 24 * 3_600_000))

    const key = freshKey()
    const first = await declineBooking({ bookingId, reason: 'practitioner_unavailable', idempotencyKey: key }, deps)
    const second = await declineBooking({ bookingId, reason: 'practitioner_unavailable', idempotencyKey: key }, deps)

    expect(second.refund.refundId).toBe(first.refund.refundId)

    // Idempotent replay short-circuits before touching the event log again — still exactly 5 decline events.
    const allEvents = await loadEventLog(bookingId)
    expect(allEvents.filter((e) => e.type === 'REFUND_ISSUED')).toHaveLength(1)
  })

  it('a partial failure mid-sequence rolls back all five decline events, not just the failing one', async () => {
    clock.set(new Date(slotAt('13:00').getTime() - 5 * 24 * 3_600_000))
    const { bookingId } = await holdAndConfirm('13:00')

    const before = await loadEventLog(bookingId)
    const nextSequence = before[before.length - 1]!.sequence + 1

    // Four events, well-formed, except the last one deliberately reuses the
    // same sequence number as the one before it — a stand-in for "something
    // goes wrong partway through the real five-event decline write."
    // events_booking_sequence_unique (bookingId, sequence) rejects the
    // duplicate, and because the whole batch is one INSERT in one
    // transaction, Postgres must fail the entire statement — there is no
    // way for the first two rows to land while the last two are rejected.
    // This is the same append() the real five-event decline write uses, so
    // it proves the atomicity that write depends on.
    await expect(
      deps.eventStore.transaction(async (tx) => {
        const declinedEvent = createMerchantDeclinedEvent(bookingId, nextSequence, clock, { reason: 'x', cause: 'MERCHANT' })
        const slotReleasedEvent = createSlotReleasedEvent(bookingId, nextSequence + 1, clock, {
          practitionerId: SEED_PRACTITIONER_ID,
          startsAt: slotAt('13:00'),
        })
        const refundEvent = createRefundIssuedEvent(bookingId, nextSequence + 2, clock, {
          action: { direction: 'debit', amountPaise: toPaise(30000), instrument: 'upi' },
          gate: { cleared: ['merchant_caused_cancellation'], evidence: {} },
          bound: { ceilingPaise: toPaise(30000), enforcedBy: 'latch_policy', headroomAfterPaise: toPaise(0) },
          authority: { policyVersion: 1 },
        })
        const duplicateSequenceEvent = createMerchantDeclinedEvent(bookingId, nextSequence + 2, clock, { reason: 'boom', cause: 'MERCHANT' })

        await tx.append([declinedEvent, slotReleasedEvent, refundEvent, duplicateSequenceEvent], undefined, deps.merchantId)
      }),
    ).rejects.toThrow()

    const after = await loadEventLog(bookingId)
    expect(after).toHaveLength(before.length) // none of the four landed — not even the first three
  })
})
