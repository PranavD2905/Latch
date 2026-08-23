import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { confirmWithDeposit } from '../../app/confirm-with-deposit.js'
import { getPolicy } from '../../app/get-policy.js'
import { holdSlot } from '../../app/hold-slot.js'
import type { AppDeps } from '../../app/types.js'
import { FrozenClock } from '../clock/frozen-clock.js'
import { createDbClient } from '../db/client.js'
import { PostgresCatalogRepo } from '../db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../db/postgres-idempotency-store.js'
import { bookings, events } from '../db/schema.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../db/seed-data.js'
import { FakePaymentProvider } from '../payment/fake-payment-provider.js'
import { createMerchantApiServer } from './server.js'

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))
const MERCHANT_TOKEN = 'test-merchant-token'

const deps: AppDeps = {
  clock,
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider: new FakePaymentProvider(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  merchantId: SEED_MERCHANT_ID,
}

const app = createMerchantApiServer(deps, { merchantToken: MERCHANT_TOKEN })

// Wednesday 2026-09-16, a day no other integration-test file books against.
const BASE_DAY = '2026-09-16'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}

const createdBookingIds: string[] = []
function freshKey(): string {
  return `test_${ulid()}`
}

async function confirmedBooking(hhmm: string): Promise<string> {
  const startsAt = slotAt(hhmm)
  clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
  const agentId = `agent_${ulid()}`
  const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
  createdBookingIds.push(held.bookingId)
  const policyResult = await getPolicy(deps)
  await confirmWithDeposit(
    { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() },
    deps,
  )
  return held.bookingId
}

beforeAll(async () => {
  const policy = await deps.catalogRepo.getActivePolicy(SEED_MERCHANT_ID)
  if (!policy) {
    throw new Error('seed data missing — run `npm run db:seed` before this test suite')
  }
  await app.ready()
})

afterAll(async () => {
  await app.close()
  for (const bookingId of createdBookingIds) {
    await db.delete(events).where(eq(events.bookingId, bookingId))
    await db.delete(bookings).where(eq(bookings.bookingId, bookingId))
  }
  await sql.end()
})

describe('merchant API — decline_booking, the only surface that can trigger it', () => {
  it('rejects a request with no Authorization header', async () => {
    const bookingId = await confirmedBooking('09:00')
    const response = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/decline`,
      payload: { reason: 'practitioner_unavailable', idempotencyKey: freshKey() },
    })
    expect(response.statusCode).toBe(401)

    // The rejection happened before the money action ran — no decline events, booking still CONFIRMED.
    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
  })

  it('rejects a request with the wrong token', async () => {
    const bookingId = await confirmedBooking('09:30')
    const response = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/decline`,
      headers: { authorization: 'Bearer not-the-real-token' },
      payload: { reason: 'practitioner_unavailable', idempotencyKey: freshKey() },
    })
    expect(response.statusCode).toBe(401)
  })

  it('with the correct merchant token, declines a confirmed booking end to end', async () => {
    const bookingId = await confirmedBooking('10:00')
    const response = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/decline`,
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
      payload: { reason: 'practitioner_unavailable', idempotencyKey: freshKey() },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe('DECLINED_BY_MERCHANT')
    expect(body.refund.amountPaise).toBeGreaterThan(0)

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('DECLINED_BY_MERCHANT')
  })

  it('404s for an unknown booking, even with a valid token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/bookings/bkg_does_not_exist/decline`,
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
      payload: { reason: 'x', idempotencyKey: freshKey() },
    })
    expect(response.statusCode).toBe(404)
  })

  it('409s for a booking that is not yet CONFIRMED', async () => {
    const startsAt = slotAt('11:00')
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
    const held = await holdSlot(
      { agentId: `agent_${ulid()}`, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(held.bookingId)

    const response = await app.inject({
      method: 'POST',
      url: `/bookings/${held.bookingId}/decline`,
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
      payload: { reason: 'x', idempotencyKey: freshKey() },
    })
    expect(response.statusCode).toBe(409)
  })

  it('400s a request missing `reason`, before it ever reaches declineBooking', async () => {
    const bookingId = await confirmedBooking('12:00')
    const response = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/decline`,
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
      payload: { idempotencyKey: freshKey() },
    })
    expect(response.statusCode).toBe(400)

    // Rejected at the schema, not by the app layer — booking is untouched.
    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
  })
})
