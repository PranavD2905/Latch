import { and, eq } from 'drizzle-orm'
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
import { holdSlot } from './hold-slot.js'
import type { AppDeps } from './types.js'

/**
 * prompts/slice-8.md item 1 — the ⭐ test. This is not asserting that the
 * app *tries* to prevent double-booking; it asserts the outcome an agent
 * would actually observe when N of them race for the same slot: exactly one
 * winner, everyone else a clean `SLOT_TAKEN`, exactly one live row, and the
 * trail agreeing.
 *
 * "This must exercise the partial unique index, not an application check."
 * That claim is *verified*, not just asserted, in a separate manual step —
 * see dev-logs/013 for the drop-the-index-and-watch-it-fail record. Doing
 * that automatically inside this file (dropping/recreating a real index on
 * the shared local dev database this repo's other concurrent Claude Code
 * sessions may also be using — dev-logs/012's collision-risk note) is a
 * real-infrastructure risk worth avoiding in a committed test that runs on
 * every `npm test`, so it stays a manual, one-time, logged verification
 * instead of an automated part of this suite.
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

// Wednesday 2026-09-30, a day no other integration-test file books against.
const BASE_DAY = '2026-09-30'
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

describe('concurrency — one slot, N agents (docs/01-architecture.md §4)', () => {
  it('exactly one of N concurrent agents wins the same slot; every loser gets SLOT_TAKEN; exactly one live booking row exists; only the winner has a HOLD_CREATED', async () => {
    const startsAt = slotAt('09:00')
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))

    const N = 12
    const agentIds = Array.from({ length: N }, () => `agent_${ulid()}`)

    const outcomes = await Promise.allSettled(
      agentIds.map((agentId) =>
        holdSlot(
          { agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() },
          deps,
        ),
      ),
    )

    const winners = outcomes.filter((o) => o.status === 'fulfilled')
    const losers = outcomes.filter((o) => o.status === 'rejected')

    // Exactly one succeeds.
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(N - 1)

    // Every loser gets SLOT_TAKEN specifically — not some other error.
    for (const loser of losers) {
      if (loser.status === 'rejected') {
        expect(loser.reason).toMatchObject({ code: 'SLOT_TAKEN' })
      }
    }

    const winner = winners[0]
    if (winner === undefined || winner.status !== 'fulfilled') throw new Error('unreachable — already asserted length 1')
    createdBookingIds.push(winner.value.bookingId)

    // Exactly one live booking row exists for this (practitioner, starts_at)
    // — the DB-level fact the partial unique index actually guarantees.
    const liveRows = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.practitionerId, SEED_PRACTITIONER_ID), eq(bookings.startsAt, startsAt)))
    const liveOnes = liveRows.filter((r) => r.status === 'held' || r.status === 'confirmed')
    expect(liveOnes).toHaveLength(1)
    expect(liveOnes[0]?.bookingId).toBe(winner.value.bookingId)

    // The winner's HOLD_CREATED is in the trail, and no loser's is — losers
    // never got far enough to write one (refusal.ts's refuseStandalone
    // records only an ACTION_REFUSED, against an ephemeral bookingId that
    // never became a live booking).
    const winnerTrail = await loadEventLog(winner.value.bookingId)
    expect(winnerTrail.filter((e) => e.type === 'HOLD_CREATED')).toHaveLength(1)

    const allEventsForSlot = await db.select().from(events)
    const holdCreatedForThisSlot = allEventsForSlot.filter((row) => {
      const payload = row.payload as { type: string; practitionerId?: string; startsAt?: string }
      return payload.type === 'HOLD_CREATED' && payload.practitionerId === SEED_PRACTITIONER_ID && payload.startsAt === startsAt.toISOString()
    })
    expect(holdCreatedForThisSlot).toHaveLength(1)
    expect(holdCreatedForThisSlot[0]?.bookingId).toBe(winner.value.bookingId)

    // Every loser's refusal is itself in the trail (docs/03-domain-model.md
    // §4 footnote ★★ — refusals are events too), naming this exact slot.
    const refusalsForThisSlot = allEventsForSlot.filter((row) => {
      const payload = row.payload as { type: string; refusalCode?: string; reason?: string }
      return payload.type === 'ACTION_REFUSED' && payload.refusalCode === 'SLOT_TAKEN' && payload.reason?.includes(startsAt.toISOString())
    })
    expect(refusalsForThisSlot.length).toBeGreaterThanOrEqual(N - 1)
  })
})
