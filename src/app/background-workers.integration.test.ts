import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../adapters/db/seed-data.js'
import { bookings, events } from '../adapters/db/schema.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import type { BookingEvent } from '../domain/events.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import { runHoldExpiryWorker } from './hold-expiry-worker.js'
import { runNoShowEligibilityWorker } from './no-show-eligibility-worker.js'
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
  merchantId: SEED_MERCHANT_ID,
}

// Friday 2026-09-18, a day this suite doesn't share with any other integration suite.
const BASE_DAY = '2026-09-18'
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

let policyHoldTtlSeconds = 0
let policyGraceMinutes = 0

beforeAll(async () => {
  const policy = await deps.catalogRepo.getActivePolicy(SEED_MERCHANT_ID)
  if (!policy) {
    throw new Error('seed data missing — run `npm run db:seed` before this test suite')
  }
  policyHoldTtlSeconds = policy.holdTtlSeconds
  policyGraceMinutes = policy.noShowGraceMinutes
})

afterAll(async () => {
  for (const bookingId of createdBookingIds) {
    await db.delete(events).where(eq(events.bookingId, bookingId))
    await db.delete(bookings).where(eq(bookings.bookingId, bookingId))
  }
  await sql.end()
})

describe('hold-expiry-worker (real Postgres + FrozenClock) — docs/01-architecture.md §8/§9', () => {
  it('expires a held booking whose TTL has elapsed, and the slot becomes bookable again', async () => {
    clock.set(new Date(slotAt('09:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    clock.advance((policyHoldTtlSeconds + 1) * 1000) // past the TTL
    const { expiredBookingIds } = await runHoldExpiryWorker(deps)
    expect(expiredBookingIds).toContain(held.bookingId)

    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('EXPIRED')

    const allEvents = await loadEventLog(held.bookingId)
    expect(allEvents.at(-1)?.type).toBe('HOLD_EXPIRED')

    const rebooked = await holdSlot(
      { agentId: `agent_${ulid()}`, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:00'), idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(rebooked.bookingId)
    expect(rebooked.status).toBe('HELD')
  })

  it('leaves a live, unexpired hold alone', async () => {
    clock.set(new Date(slotAt('10:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('10:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    const { expiredBookingIds } = await runHoldExpiryWorker(deps)
    expect(expiredBookingIds).not.toContain(held.bookingId)

    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('HELD')
  })

  it('is idempotent: running twice in a row appends HOLD_EXPIRED only once', async () => {
    clock.set(new Date(slotAt('11:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('11:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    clock.advance((policyHoldTtlSeconds + 1) * 1000)
    const first = await runHoldExpiryWorker(deps)
    const second = await runHoldExpiryWorker(deps)

    expect(first.expiredBookingIds).toContain(held.bookingId)
    expect(second.expiredBookingIds).not.toContain(held.bookingId) // status is no longer HELD — the claim query no longer matches it

    const allEvents = await loadEventLog(held.bookingId)
    expect(allEvents.filter((e) => e.type === 'HOLD_EXPIRED')).toHaveLength(1)
  })
})

describe('no-show-eligibility-worker (real Postgres + FrozenClock) — makes a charge permissible, never charges', () => {
  async function holdAndConfirm(startsAt: Date): Promise<string> {
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)
    const policyResult = await getPolicy(deps)
    await confirmWithDeposit({ bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() }, deps)
    return held.bookingId
  }

  it('marks a booking eligible once start + grace has elapsed, without charging or moving it off CONFIRMED', async () => {
    clock.set(new Date(slotAt('12:00').getTime() - 5 * 24 * 3_600_000))
    const bookingId = await holdAndConfirm(slotAt('12:00'))

    clock.set(new Date(slotAt('12:00').getTime() + (policyGraceMinutes + 1) * 60_000))
    const { eligibleBookingIds } = await runNoShowEligibilityWorker(deps)
    expect(eligibleBookingIds).toContain(bookingId)

    const allEvents = await loadEventLog(bookingId)
    expect(allEvents.at(-1)?.type).toBe('NO_SHOW_ELIGIBLE')
    expect(allEvents.some((e) => e.type === 'NO_SHOW_CHARGED')).toBe(false) // it never charges

    // Deliberately does not flip status away from CONFIRMED — charge_no_show
    // (and cancel/reschedule) key off status === 'CONFIRMED' directly
    // (dev-logs/009/010); this event is informational only.
    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
  })

  it('does not fire before start + grace has elapsed (start passed, still inside grace)', async () => {
    clock.set(new Date(slotAt('13:00').getTime() - 5 * 24 * 3_600_000))
    const bookingId = await holdAndConfirm(slotAt('13:00'))

    clock.set(new Date(slotAt('13:00').getTime() + Math.max(policyGraceMinutes - 1, 0) * 60_000))
    const { eligibleBookingIds } = await runNoShowEligibilityWorker(deps)
    expect(eligibleBookingIds).not.toContain(bookingId)

    const allEvents = await loadEventLog(bookingId)
    expect(allEvents.some((e) => e.type === 'NO_SHOW_ELIGIBLE')).toBe(false)
  })

  it('is idempotent: running twice in a row appends NO_SHOW_ELIGIBLE only once', async () => {
    clock.set(new Date(slotAt('14:00').getTime() - 5 * 24 * 3_600_000))
    const bookingId = await holdAndConfirm(slotAt('14:00'))

    clock.set(new Date(slotAt('14:00').getTime() + (policyGraceMinutes + 1) * 60_000))
    const first = await runNoShowEligibilityWorker(deps)
    const second = await runNoShowEligibilityWorker(deps)

    expect(first.eligibleBookingIds).toContain(bookingId)
    expect(second.eligibleBookingIds).not.toContain(bookingId)

    const allEvents = await loadEventLog(bookingId)
    expect(allEvents.filter((e) => e.type === 'NO_SHOW_ELIGIBLE')).toHaveLength(1)
  })
})

describe('Race 2 — hold expiry vs. confirm (docs/03-domain-model.md §7)', () => {
  it('a genuinely concurrent worker-expiry and confirm produce exactly one coherent outcome, never a capture against a released slot', async () => {
    clock.set(new Date(slotAt('15:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('15:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    const policyResult = await getPolicy(deps)
    clock.advance((policyHoldTtlSeconds + 1) * 1000) // the hold is already expired, from both paths' point of view

    const [workerOutcome, confirmOutcome] = await Promise.allSettled([
      runHoldExpiryWorker(deps),
      confirmWithDeposit(
        { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() },
        deps,
      ),
    ])

    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(['EXPIRED', 'CONFIRMED']).toContain(snapshot?.status) // exactly one coherent outcome, never left ambiguous

    const allEvents = await loadEventLog(held.bookingId)
    const depositCaptured = allEvents.some((e) => e.type === 'DEPOSIT_CAPTURED')

    if (snapshot?.status === 'EXPIRED') {
      expect(depositCaptured).toBe(false) // no money captured against a released slot
      expect(confirmOutcome.status).toBe('rejected')
      if (confirmOutcome.status === 'rejected') {
        expect(confirmOutcome.reason).toMatchObject({ code: 'HOLD_EXPIRED' })
      }
    } else {
      expect(depositCaptured).toBe(true) // confirm genuinely won the race and captured for real
      expect(workerOutcome.status === 'fulfilled' && workerOutcome.value.expiredBookingIds).not.toContain(held.bookingId)
    }
  })
})
