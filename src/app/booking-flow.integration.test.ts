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
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { findSlots } from './find-slots.js'
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
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider,
  paymentRail: new FakePaymentRail(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  merchantId: SEED_MERCHANT_ID,
}

// Thursday 2026-09-03, within Dr. Rao's seeded 09:00-13:00 working window.
// Each test uses its own 30-min slot so tests never collide with each other.
const BASE_DAY = '2026-09-03'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}

const createdBookingIds: string[] = []
const usedIdempotencyKeys: string[] = []

function freshKey(): string {
  const key = `test_${ulid()}`
  usedIdempotencyKeys.push(key)
  return key
}

beforeAll(async () => {
  // Confirm the seed ran (prompts/README.md / dev-logs/003 note npm run db:seed is required once).
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
  // Sweep any ACTION_REFUSED events recorded against ephemeral (never-projected) bookingIds too.
  await sql.end()
})

describe('booking-flow (real Postgres + FakePaymentProvider + FrozenClock)', () => {
  it('completes find_slots -> get_policy -> hold_slot -> confirm_with_deposit end to end', async () => {
    clock.set(new Date(slotAt('09:00').getTime() - 5 * 24 * 3_600_000))

    const found = await findSlots({ practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, days: 14 }, deps)
    expect(found.slots).toContain(slotAt('09:00').toISOString())

    const policyResult = await getPolicy(deps)
    expect(policyResult.policy.policyVersion).toBeGreaterThan(0)

    const agentId = `agent_${ulid()}`
    const held = await holdSlot(
      { agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:00'), idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(held.bookingId)
    expect(held.status).toBe('HELD')

    const confirmed = await confirmWithDeposit(
      { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() },
      deps,
    )
    expect(confirmed.status).toBe('CONFIRMED')
    expect(confirmed.deposit.amountPaise).toBe(policyResult.policy.depositAmountPaise)

    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
  })

  it('refuses confirm_with_deposit with POLICY_NOT_ACKNOWLEDGED when the policy was never acknowledged, and records it', async () => {
    clock.set(new Date(slotAt('09:30').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot(
      { agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:30'), idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(held.bookingId)

    await expect(
      confirmWithDeposit({ bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: undefined, idempotencyKey: freshKey() }, deps),
    ).rejects.toMatchObject({ code: 'POLICY_NOT_ACKNOWLEDGED' })

    const eventRows = await db.select().from(events).where(eq(events.bookingId, held.bookingId))
    const refusal = eventRows.find((e) => e.type === 'ACTION_REFUSED')
    expect(refusal).toBeDefined()
    expect((refusal?.payload as { refusalCode?: string })?.refusalCode).toBe('POLICY_NOT_ACKNOWLEDGED')

    // The booking is still HELD — a refused confirm does not touch the booking's status.
    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('HELD')
  })

  it('refuses confirm_with_deposit with HOLD_EXPIRED once the TTL has elapsed, and records it', async () => {
    const startsAt = slotAt('10:00')
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot(
      { agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(held.bookingId)

    // Advance the frozen clock past the hold's TTL (policy seed: 600s).
    clock.advance(700_000)

    const policyResult = await getPolicy(deps)
    await expect(
      confirmWithDeposit(
        { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'HOLD_EXPIRED' })

    const eventRows = await db.select().from(events).where(eq(events.bookingId, held.bookingId))
    const refusal = eventRows.find((e) => e.type === 'ACTION_REFUSED')
    expect((refusal?.payload as { refusalCode?: string })?.refusalCode).toBe('HOLD_EXPIRED')
  })

  it('refuses hold_slot with HOLD_LIMIT_REACHED once the agent already has the maximum live holds, and records it', async () => {
    const agentId = `agent_${ulid()}`
    clock.set(new Date(slotAt('11:00').getTime() - 5 * 24 * 3_600_000))
    const policyResult = await getPolicy(deps)
    const limit = policyResult.policy.maxConcurrentHoldsPerAgent

    const slotTimes = ['11:00', '11:30', '12:00', '12:30']
    expect(slotTimes.length).toBeGreaterThan(limit) // sanity: seed must allow one more slot than the limit

    for (let i = 0; i < limit; i++) {
      const held = await holdSlot(
        {
          agentId,
          practitionerId: SEED_PRACTITIONER_ID,
          serviceId: SEED_SERVICE_ID,
          startsAt: slotAt(slotTimes[i]!),
          idempotencyKey: freshKey(),
        },
        deps,
      )
      createdBookingIds.push(held.bookingId)
    }

    // One more, over the limit, on a still-free slot — must be refused on the bound, not on slot availability.
    await expect(
      holdSlot(
        {
          agentId,
          practitionerId: SEED_PRACTITIONER_ID,
          serviceId: SEED_SERVICE_ID,
          startsAt: slotAt(slotTimes[limit]!),
          idempotencyKey: freshKey(),
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'HOLD_LIMIT_REACHED' })

    // This refusal has no live booking to attach to (see src/app/refusal.ts) — search recent
    // ACTION_REFUSED events for one whose reason names this agent.
    const refusedEvents = await db.select().from(events).where(eq(events.type, 'ACTION_REFUSED'))
    const match = refusedEvents.find((e) => {
      const payload = e.payload as { refusalCode?: string; reason?: string }
      return payload.refusalCode === 'HOLD_LIMIT_REACHED' && payload.reason?.includes(agentId)
    })
    expect(match).toBeDefined()
  })

  it('refuses hold_slot with SLOT_TAKEN when a second agent targets an already-live slot, and records it', async () => {
    const startsAt = slotAt('14:00') // afternoon window
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))

    const firstAgent = `agent_${ulid()}`
    const secondAgent = `agent_${ulid()}`

    const held = await holdSlot(
      { agentId: firstAgent, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(held.bookingId)

    await expect(
      holdSlot({ agentId: secondAgent, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps),
    ).rejects.toMatchObject({ code: 'SLOT_TAKEN' })

    const refusedEvents = await db.select().from(events).where(eq(events.type, 'ACTION_REFUSED'))
    const match = refusedEvents.find((e) => {
      const payload = e.payload as { refusalCode?: string; reason?: string }
      return payload.refusalCode === 'SLOT_TAKEN' && payload.reason?.includes(startsAt.toISOString())
    })
    expect(match).toBeDefined()
  })

  // docs/01-architecture.md §1 Idea 3 claims concurrent-holds-per-agent is
  // "Latch + DB constraint" — the same "impossible, not merely caught" tier
  // as the slot-uniqueness index. A plain count-then-insert would NOT
  // deliver that (two concurrent calls can both read a count under the
  // limit before either inserts) — src/app/hold-slot.ts closes the race
  // with `tx.lockAgent()`, a Postgres advisory lock. This test actually
  // fires the race, rather than asserting the mechanism exists.
  it('under real concurrent hold_slot calls from one agent, at most maxConcurrentHoldsPerAgent ever succeed', async () => {
    clock.set(new Date(slotAt('15:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_race_${ulid()}`
    const policyResult = await getPolicy(deps)
    const limit = policyResult.policy.maxConcurrentHoldsPerAgent

    const raceSlotTimes = ['15:00', '15:30', '16:00', '16:30', '17:00']
    expect(raceSlotTimes.length).toBeGreaterThan(limit) // sanity: attempt strictly more than the limit

    const outcomes = await Promise.allSettled(
      raceSlotTimes.map((hhmm) =>
        holdSlot(
          { agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt(hhmm), idempotencyKey: freshKey() },
          deps,
        ),
      ),
    )

    const succeeded = outcomes.filter((o) => o.status === 'fulfilled')
    const refused = outcomes.filter((o) => o.status === 'rejected')
    for (const s of succeeded) {
      if (s.status === 'fulfilled') createdBookingIds.push(s.value.bookingId)
    }

    expect(succeeded).toHaveLength(limit)
    expect(refused).toHaveLength(raceSlotTimes.length - limit)
    for (const r of refused) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'HOLD_LIMIT_REACHED' })
    }

    // Belt and braces: the DB agrees with the app-level count, since the
    // whole point is that the two can never disagree under this lock.
    const liveHolds = await deps.eventStore.countLiveHoldsForAgent(agentId)
    expect(liveHolds).toBe(limit)
  })
})
