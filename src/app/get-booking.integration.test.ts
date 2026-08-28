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
import { bookings, events } from '../adapters/db/schema.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../adapters/db/seed-data.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import { BookingNotFoundError, getBooking } from './get-booking.js'
import { holdSlot } from './hold-slot.js'
import type { AppDeps } from './types.js'

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

// Thursday 2026-09-10, within Dr. Rao's seeded 09:00-13:00 working window —
// a day this file owns exclusively so it never collides with other
// integration test files' fixture slots.
const BASE_DAY = '2026-09-10'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}

const createdBookingIds: string[] = []

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

describe('get_booking (real Postgres) — the reconciliation tool a timed-out write leaves an agent needing', () => {
  it('reports live status for a booking that exists', async () => {
    clock.set(new Date(slotAt('09:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot(
      { agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:00'), idempotencyKey: `test_${ulid()}` },
      deps,
    )
    createdBookingIds.push(held.bookingId)

    const result = await getBooking({ bookingId: held.bookingId }, deps)
    expect(result.booking.bookingId).toBe(held.bookingId)
    expect(result.booking.status).toBe('HELD')
    expect(result.booking.agentId).toBe(agentId)
  })

  it('throws BookingNotFoundError for an unknown bookingId, same as every other command that reads one', async () => {
    await expect(getBooking({ bookingId: 'bkg_does_not_exist' }, deps)).rejects.toThrow(BookingNotFoundError)
  })
})
