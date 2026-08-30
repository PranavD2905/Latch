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
import { BookingNotChargeableError, chargeNoShow } from './charge-no-show.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { requireConfirmed } from './confirm-with-deposit-test-support.js'
import { demoCeilingRefusal } from './demo-ceiling-refusal.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import { markNoShow } from './mark-no-show.js'
import type { AppDeps } from './types.js'

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))

const deps: AppDeps = {
  clock,
  logger: createNoopLogger(),
  paymentCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider: new FakePaymentProvider(),
  paymentRail: new FakePaymentRail(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
  merchantId: SEED_MERCHANT_ID,
}

// Tuesday 2026-09-22, a day no other integration-test file books against.
const BASE_DAY = '2026-09-22'
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

async function holdAndConfirm(hhmm: string): Promise<{ bookingId: string; startsAt: Date; authorizationAmountPaise: number }> {
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
  return { bookingId: held.bookingId, startsAt, authorizationAmountPaise: confirmed.authorization!.amountPaise }
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

describe('charge_no_show (real Postgres + FakePaymentRail + FrozenClock) — the two-independent-facts gate', () => {
  it('refuses NOT_YET_ELIGIBLE before start + grace, and records it', async () => {
    clock.set(new Date(slotAt('09:00').getTime() - 2 * 3_600_000)) // 2h before appointment — well within the 5-day authorization window
    const { bookingId, startsAt } = await holdAndConfirm('09:00')

    clock.set(new Date(startsAt.getTime() - 5 * 60_000)) // 5 minutes before start — not yet even started, let alone past grace
    await expect(chargeNoShow({ bookingId, idempotencyKey: freshKey() }, deps)).rejects.toMatchObject({ code: 'NOT_YET_ELIGIBLE' })

    const trail = await loadEventLog(bookingId)
    const refusal = trail.find((e) => e.type === 'ACTION_REFUSED')
    expect(refusal).toMatchObject({ refusalCode: 'NOT_YET_ELIGIBLE' })

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('CONFIRMED') // untouched — a refusal never flips state
  })

  it('refuses MERCHANT_ACTION_REQUIRED once start + grace has elapsed but nobody has marked non-attendance', async () => {
    clock.set(new Date(slotAt('09:30').getTime() - 2 * 3_600_000))
    const { bookingId, startsAt } = await holdAndConfirm('09:30')

    clock.set(new Date(startsAt.getTime() + 16 * 60_000)) // past the 15-minute grace, nobody marked
    await expect(chargeNoShow({ bookingId, idempotencyKey: freshKey() }, deps)).rejects.toMatchObject({ code: 'MERCHANT_ACTION_REQUIRED' })

    const trail = await loadEventLog(bookingId)
    expect(trail.find((e) => e.type === 'ACTION_REFUSED')).toMatchObject({ refusalCode: 'MERCHANT_ACTION_REQUIRED' })
  })

  it('captures the no-show fee once both facts hold, and is idempotent on replay', async () => {
    clock.set(new Date(slotAt('10:00').getTime() - 2 * 3_600_000))
    const { bookingId, startsAt, authorizationAmountPaise } = await holdAndConfirm('10:00')

    clock.set(new Date(startsAt.getTime() + 16 * 60_000))
    await markNoShow({ bookingId, idempotencyKey: freshKey() }, deps)

    const key = freshKey()
    const first = await chargeNoShow({ bookingId, idempotencyKey: key }, deps)
    expect(first.status).toBe('NO_SHOW_CHARGED')
    expect(first.charge.amountPaise).toBe(authorizationAmountPaise) // exactly the authorised amount — no headroom

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('NO_SHOW_CHARGED')

    const second = await chargeNoShow({ bookingId, idempotencyKey: key }, deps)
    expect(second.charge.paymentId).toBe(first.charge.paymentId)

    const trail = await loadEventLog(bookingId)
    expect(trail.filter((e) => e.type === 'NO_SHOW_CHARGED')).toHaveLength(1) // replay never double-captures

    const chargedEvent = trail.find((e) => e.type === 'NO_SHOW_CHARGED')
    expect(chargedEvent).toMatchObject({
      rail: 'manual_capture',
      action: { direction: 'debit', amountPaise: authorizationAmountPaise, instrument: 'card' },
      bound: { ceilingPaise: authorizationAmountPaise, enforcedBy: 'payment_rail', headroomAfterPaise: 0 },
      gate: { cleared: ['start_time_elapsed', 'merchant_marked_non_attendance'] },
    })
  })

  it('refuses to charge a booking that is not CONFIRMED (already charged)', async () => {
    clock.set(new Date(slotAt('11:00').getTime() - 2 * 3_600_000))
    const { bookingId, startsAt } = await holdAndConfirm('11:00')
    clock.set(new Date(startsAt.getTime() + 16 * 60_000))
    await markNoShow({ bookingId, idempotencyKey: freshKey() }, deps)
    await chargeNoShow({ bookingId, idempotencyKey: freshKey() }, deps)

    // A second, genuinely fresh attempt (different key) against the now-NO_SHOW_CHARGED booking.
    await expect(chargeNoShow({ bookingId, idempotencyKey: freshKey() }, deps)).rejects.toBeInstanceOf(BookingNotChargeableError)
  })

  it('AUTHORIZATION_EXPIRED once the authorisation-lapse worker has recorded the lapse, with AUTHORIZATION_LAPSED already in the trail', async () => {
    clock.set(new Date(slotAt('12:00').getTime() - 2 * 3_600_000))
    const { bookingId, startsAt } = await holdAndConfirm('12:00')

    // Well past both the grace period and the 5-day manual_expiry_period.
    clock.set(new Date(startsAt.getTime() + 6 * 24 * 3_600_000))
    await markNoShow({ bookingId, idempotencyKey: freshKey() }, deps)

    const { lapsedBookingIds } = await runAuthorizationLapseWorker(deps)
    expect(lapsedBookingIds).toContain(bookingId)

    const trailBeforeCharge = await loadEventLog(bookingId)
    expect(trailBeforeCharge.find((e) => e.type === 'AUTHORIZATION_LAPSED')).toMatchObject({ rail: 'manual_capture' })

    await expect(chargeNoShow({ bookingId, idempotencyKey: freshKey() }, deps)).rejects.toMatchObject({ code: 'AUTHORIZATION_EXPIRED' })

    const trail = await loadEventLog(bookingId)
    expect(trail.find((e) => e.type === 'ACTION_REFUSED' && (e as { refusalCode?: string }).refusalCode === 'AUTHORIZATION_EXPIRED')).toBeDefined()

    // Uncollectable, but the booking itself is untouched — status stays CONFIRMED (docs/03-domain-model.md §3).
    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
  })

  it('the authorisation-lapse worker is idempotent: a second run does not re-append AUTHORIZATION_LAPSED', async () => {
    clock.set(new Date(slotAt('13:00').getTime() - 2 * 3_600_000))
    const { bookingId, startsAt } = await holdAndConfirm('13:00')
    clock.set(new Date(startsAt.getTime() + 6 * 24 * 3_600_000))

    const first = await runAuthorizationLapseWorker(deps)
    expect(first.lapsedBookingIds).toContain(bookingId)
    const second = await runAuthorizationLapseWorker(deps)
    expect(second.lapsedBookingIds).not.toContain(bookingId)

    const trail = await loadEventLog(bookingId)
    expect(trail.filter((e) => e.type === 'AUTHORIZATION_LAPSED')).toHaveLength(1)
  })

  it('⭐ item 7 — the rail refuses a capture above the authorised amount, and it lands in the trail naming payment_rail', async () => {
    clock.set(new Date(slotAt('14:00').getTime() - 2 * 3_600_000))
    const { bookingId, authorizationAmountPaise } = await holdAndConfirm('14:00')

    const result = await demoCeilingRefusal(bookingId, deps)
    expect(result.refusalCode).toBe('CAPTURE_AMOUNT_MISMATCH')
    expect(result.authorizedAmountPaise).toBe(authorizationAmountPaise)
    expect(result.attemptedAmountPaise).toBe(authorizationAmountPaise + 1)

    const trail = await loadEventLog(bookingId)
    const refusal = trail.find((e) => e.type === 'ACTION_REFUSED')
    expect(refusal).toMatchObject({ refusalCode: 'CAPTURE_AMOUNT_MISMATCH', attemptedType: 'charge_no_show' })

    // The authorization itself is untouched by the refused attempt — it can still be charged for real, at the correct amount.
    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.authorizationId).toBeDefined()
    expect(snapshot?.status).toBe('CONFIRMED')
  })
})
