import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type Razorpay from 'razorpay'
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
import { FakePaymentRail } from '../payment/fake-payment-rail.js'
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
  paymentRail: new FakePaymentRail(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  merchantId: SEED_MERCHANT_ID,
}

const app = createMerchantApiServer(deps, { merchantToken: MERCHANT_TOKEN })

// dev-logs/014, item 2: a second server instance with the webhook configured
// — a fake `Razorpay` client (only `.orders.fetch` is ever called by
// `handleRazorpayWebhookPayload`) so this stays a real-Postgres integration
// test without a real Razorpay network dependency, same spirit as
// `FakePaymentProvider`/`FakePaymentRail` elsewhere in this codebase.
const WEBHOOK_SECRET = 'test-webhook-secret'
const orderNotesById = new Map<string, { bookingId: string }>()
const fakeRazorpay = {
  orders: {
    fetch: async (orderId: string) => {
      const notes = orderNotesById.get(orderId)
      if (!notes) throw new Error(`no such order: ${orderId}`)
      return { id: orderId, notes }
    },
  },
} as unknown as Razorpay
const webhookApp = createMerchantApiServer(deps, { merchantToken: MERCHANT_TOKEN, webhook: { secret: WEBHOOK_SECRET, razorpay: fakeRazorpay } })

function signedWebhookRequest(body: unknown): { payload: string; signature: string } {
  const payload = JSON.stringify(body)
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex')
  return { payload, signature }
}

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
  await webhookApp.ready()
})

afterAll(async () => {
  await app.close()
  await webhookApp.close()
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

describe('merchant API — mark_no_show, the second of charge_no_show’s two independent facts', () => {
  it('rejects a request with no Authorization header', async () => {
    const bookingId = await confirmedBooking('13:00')
    const response = await app.inject({ method: 'POST', url: `/bookings/${bookingId}/mark-no-show`, payload: { idempotencyKey: freshKey() } })
    expect(response.statusCode).toBe(401)
    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.nonAttendanceMarkedAt).toBeUndefined()
  })

  it('with the correct merchant token, marks a confirmed booking as a no-show', async () => {
    const bookingId = await confirmedBooking('13:30')
    const response = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/mark-no-show`,
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
      payload: { idempotencyKey: freshKey() },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.bookingId).toBe(bookingId)
    expect(body.nonAttendanceMarkedAt).toBeTruthy()

    const trail = await db.select().from(events).where(eq(events.bookingId, bookingId))
    const marked = trail.find((e) => e.type === 'NON_ATTENDANCE_MARKED')
    expect(marked?.payload).toMatchObject({ markedBy: 'merchant' })

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    expect(snapshot?.nonAttendanceMarkedAt).toBeDefined()
    expect(snapshot?.status).toBe('CONFIRMED') // marking non-attendance does not itself move money or change status
  })

  it('re-marking an already-marked booking is a no-op — exactly one NON_ATTENDANCE_MARKED event', async () => {
    const bookingId = await confirmedBooking('14:00')
    await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/mark-no-show`,
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
      payload: { idempotencyKey: freshKey() },
    })
    await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/mark-no-show`,
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
      payload: { idempotencyKey: freshKey() }, // deliberately a different key
    })

    const trail = await db.select().from(events).where(eq(events.bookingId, bookingId))
    expect(trail.filter((e) => e.type === 'NON_ATTENDANCE_MARKED')).toHaveLength(1)
  })

  it('409s for a booking that is not CONFIRMED (still HELD)', async () => {
    const startsAt = slotAt('15:00')
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
    const held = await holdSlot(
      { agentId: `agent_${ulid()}`, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(held.bookingId)

    const response = await app.inject({
      method: 'POST',
      url: `/bookings/${held.bookingId}/mark-no-show`,
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
      payload: { idempotencyKey: freshKey() },
    })
    expect(response.statusCode).toBe(409)
  })

  it('404s for an unknown booking', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/bookings/bkg_does_not_exist/mark-no-show`,
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
      payload: { idempotencyKey: freshKey() },
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('GET /slots — dev-logs/014 item 4, the second inbound adapter', () => {
  it('is reachable with no Authorization header at all — same posture as MCP find_slots', async () => {
    const response = await app.inject({ method: 'GET', url: `/slots?practitionerId=${SEED_PRACTITIONER_ID}&serviceId=${SEED_SERVICE_ID}` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.practitionerId).toBe(SEED_PRACTITIONER_ID)
    expect(Array.isArray(body.slots)).toBe(true)
  })

  it('returns exactly what findSlots (the same function find_slots calls) returns — not a parallel implementation', async () => {
    const { findSlots } = await import('../../app/find-slots.js')
    const direct = await findSlots({ practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, days: undefined }, deps)

    const response = await app.inject({ method: 'GET', url: `/slots?practitionerId=${SEED_PRACTITIONER_ID}&serviceId=${SEED_SERVICE_ID}` })
    expect(response.json()).toEqual(direct)
  })

  it('400s missing required query params, before ever reaching findSlots', async () => {
    const response = await app.inject({ method: 'GET', url: '/slots' })
    expect(response.statusCode).toBe(400)
  })

  it('404s an unknown practitioner', async () => {
    const response = await app.inject({ method: 'GET', url: `/slots?practitionerId=prac_does_not_exist&serviceId=${SEED_SERVICE_ID}` })
    expect(response.statusCode).toBe(404)
  })
})

describe('POST /webhooks/razorpay — dev-logs/014 item 2, signature-verified and idempotent', () => {
  it('503s when the webhook is not configured on this instance', async () => {
    const { payload, signature } = signedWebhookRequest({ event: 'payment.captured', payload: {} })
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      payload,
    })
    expect(response.statusCode).toBe(503)
  })

  it('400s a request with no signature header', async () => {
    const response = await webhookApp.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ event: 'payment.captured', payload: {} }),
    })
    expect(response.statusCode).toBe(400)
  })

  it('400s a request signed with the wrong secret — security-critical: an unverified payload must never reach event-appending code', async () => {
    const body = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_forged', order_id: 'order_x', status: 'captured', amount: 30000 } } } }
    const wrongSignature = createHmac('sha256', 'not-the-real-secret').update(JSON.stringify(body)).digest('hex')
    const response = await webhookApp.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': wrongSignature },
      payload: JSON.stringify(body),
    })
    expect(response.statusCode).toBe(400)
  })

  it('200s and ignores an event outside the relevant set, correctly signed', async () => {
    const { payload, signature } = signedWebhookRequest({ event: 'payment.failed', payload: {} })
    const response = await webhookApp.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      payload,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, handled: false })
  })

  it('closes gap 1: a booking still HELD (as if the process crashed before appending DEPOSIT_CAPTURED) gets RECONCILIATION_MISMATCH when Razorpay reports the payment captured', async () => {
    const startsAt = slotAt('16:00')
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
    const held = await holdSlot(
      { agentId: `agent_${ulid()}`, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(held.bookingId)

    const orderId = `order_${ulid()}`
    orderNotesById.set(orderId, { bookingId: held.bookingId })
    const body = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: `pay_${ulid()}`, order_id: orderId, status: 'captured', amount: 30000 } } },
    }
    const { payload, signature } = signedWebhookRequest(body)

    const response = await webhookApp.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      payload,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, handled: true, mismatch: true, bookingId: held.bookingId })

    const trail = await db.select().from(events).where(eq(events.bookingId, held.bookingId))
    const mismatch = trail.find((e) => e.type === 'RECONCILIATION_MISMATCH')
    expect(mismatch?.payload).toMatchObject({ subject: 'unrecorded_payment', expectedStatus: 'not_recorded', actualStatus: 'captured', detectedVia: 'webhook' })

    // The booking's own status is untouched — a mismatch is reported, not auto-repaired.
    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('HELD')

    // A redelivery of the identical event (Razorpay retries on anything but
    // a 2xx) is a safe replay, not a second append.
    const replay = await webhookApp.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      payload,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ ok: true, replayed: true })

    const trailAfterReplay = await db.select().from(events).where(eq(events.bookingId, held.bookingId))
    expect(trailAfterReplay.filter((e) => e.type === 'RECONCILIATION_MISMATCH')).toHaveLength(1)
  })
})
