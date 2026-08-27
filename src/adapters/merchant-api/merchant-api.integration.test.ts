import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type Razorpay from 'razorpay'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CircuitBreaker } from '../../app/circuit-breaker.js'
import { confirmWithDeposit } from '../../app/confirm-with-deposit.js'
import { getPolicy } from '../../app/get-policy.js'
import { holdSlot } from '../../app/hold-slot.js'
import type { SetPolicyCommand } from '../../app/set-policy.js'
import type { AppDeps } from '../../app/types.js'
import { WEBHOOK_MAX_ATTEMPTS } from '../../app/webhook-dead-letter.js'
import { FrozenClock } from '../clock/frozen-clock.js'
import { createDbClient } from '../db/client.js'
import { PostgresCatalogRepo } from '../db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../db/postgres-idempotency-store.js'
import { PostgresMerchantAuthStore } from '../db/postgres-merchant-auth.js'
import { bookings, events, merchantCredentials, merchants, policies, webhookDeadLetters } from '../db/schema.js'
import { deletePoliciesForTest } from '../db/policy-test-cleanup.js'
import { PostgresWebhookDeadLetterStore } from '../db/postgres-webhook-dead-letter-store.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../db/seed-data.js'
import { FakePaymentProvider } from '../payment/fake-payment-provider.js'
import { FakePaymentRail } from '../payment/fake-payment-rail.js'
import { createMerchantApiServer } from './server.js'

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))
const merchantAuthStore = new PostgresMerchantAuthStore(db)
// Migration 0011: a real, DB-issued credential, not a shared static
// env-var string — issued in `beforeAll` below (`vitest.config.ts` runs
// integration test files sequentially, never in parallel, so issuing
// (rotating) a `merchant_api` credential for `SEED_MERCHANT_ID` here can't
// race another file doing the same).
let MERCHANT_TOKEN: string
let POLICY_MERCHANT_TOKEN: string

const deps: AppDeps = {
  clock,
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider: new FakePaymentProvider(),
  paymentRail: new FakePaymentRail(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  merchantId: SEED_MERCHANT_ID,
  reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
}

const app = createMerchantApiServer(deps, { merchantAuthStore })

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
const webhookApp = createMerchantApiServer(deps, { merchantAuthStore, webhook: { secret: WEBHOOK_SECRET, razorpay: fakeRazorpay } })

// dev-logs/015: `/policy` on an isolated merchant, not SEED_MERCHANT_ID —
// publishing changes which version `getActivePolicy` returns, and this repo's
// convention (dev-logs/013) is that several Claude Code sessions can share
// one local Postgres at once. Isolating this merchant means these tests can
// never perturb `mer_clinic`'s active policy for an unrelated test file.
const POLICY_TEST_MERCHANT_ID = `mer_test_merchant_api_policy_${ulid()}`
const policyDeps: AppDeps = { ...deps, merchantId: POLICY_TEST_MERCHANT_ID }
const policyApp = createMerchantApiServer(policyDeps, { merchantAuthStore })

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
  await policyApp.ready()
  await db.insert(merchants).values({ merchantId: POLICY_TEST_MERCHANT_ID, name: '/policy test merchant', razorpayAccountId: 'acc_test', createdAt: new Date() })

  ;({ token: MERCHANT_TOKEN } = await merchantAuthStore.issueToken(SEED_MERCHANT_ID, 'merchant_api'))
  ;({ token: POLICY_MERCHANT_TOKEN } = await merchantAuthStore.issueToken(POLICY_TEST_MERCHANT_ID, 'merchant_api'))
})

afterAll(async () => {
  await app.close()
  await webhookApp.close()
  await policyApp.close()
  for (const bookingId of createdBookingIds) {
    await db.delete(events).where(eq(events.bookingId, bookingId))
    await db.delete(bookings).where(eq(bookings.bookingId, bookingId))
  }
  await deletePoliciesForTest(db, eq(policies.merchantId, POLICY_TEST_MERCHANT_ID))
  // The `merchant_api` credential issued for this merchant in beforeAll
  // (migration 0011) FK-references merchants.merchantId — must go before
  // the merchant row itself, same ordering constraint bookings/policies
  // already needed.
  await db.delete(merchantCredentials).where(eq(merchantCredentials.merchantId, POLICY_TEST_MERCHANT_ID))
  await db.delete(merchants).where(eq(merchants.merchantId, POLICY_TEST_MERCHANT_ID))
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
    const response = await app.inject({ method: 'GET', url: `/slots?merchant=${SEED_MERCHANT_ID}&practitionerId=${SEED_PRACTITIONER_ID}&serviceId=${SEED_SERVICE_ID}` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.practitionerId).toBe(SEED_PRACTITIONER_ID)
    expect(Array.isArray(body.slots)).toBe(true)
  })

  it('returns exactly what findSlots (the same function find_slots calls) returns — not a parallel implementation', async () => {
    const { findSlots } = await import('../../app/find-slots.js')
    const direct = await findSlots({ practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, days: undefined }, deps)

    const response = await app.inject({ method: 'GET', url: `/slots?merchant=${SEED_MERCHANT_ID}&practitionerId=${SEED_PRACTITIONER_ID}&serviceId=${SEED_SERVICE_ID}` })
    expect(response.json()).toEqual(direct)
  })

  it('400s missing required query params, before ever reaching findSlots', async () => {
    const response = await app.inject({ method: 'GET', url: '/slots' })
    expect(response.statusCode).toBe(400)
  })

  it('404s an unknown merchant', async () => {
    const response = await app.inject({ method: 'GET', url: `/slots?merchant=mer_does_not_exist&practitionerId=${SEED_PRACTITIONER_ID}&serviceId=${SEED_SERVICE_ID}` })
    expect(response.statusCode).toBe(404)
  })

  it('404s an unknown practitioner', async () => {
    const response = await app.inject({ method: 'GET', url: `/slots?merchant=${SEED_MERCHANT_ID}&practitionerId=prac_does_not_exist&serviceId=${SEED_SERVICE_ID}` })
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

  // dev-logs/016: a delivery that fails the *same way* every single time —
  // not a transient blip a normal Razorpay redelivery would outlive.
  // `amount: 12.5` is a payload no real Razorpay webhook would ever send
  // (money is always integer paise), chosen specifically because it's
  // deterministic: `toPaise` throws every time, on every identical
  // redelivery, unlike trying to simulate a real flaky network call.
  it('dead-letters a delivery that fails the same way WEBHOOK_MAX_ATTEMPTS times in a row, then stops asking Razorpay to retry it', async () => {
    const held = await holdSlot(
      { agentId: `agent_${ulid()}`, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('17:00'), idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(held.bookingId)

    const orderId = `order_${ulid()}`
    orderNotesById.set(orderId, { bookingId: held.bookingId })
    const entityId = `pay_${ulid()}`
    const body = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: entityId, order_id: orderId, status: 'captured', amount: 12.5 } } },
    }
    const { payload, signature } = signedWebhookRequest(body)

    const deliver = () => webhookApp.inject({ method: 'POST', url: '/webhooks/razorpay', headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature }, payload })

    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      const response = await deliver()
      expect(response.statusCode).toBe(500) // still under budget — Razorpay's own redelivery is still the right thing to keep happening
    }

    const finalAttempt = await deliver()
    expect(finalAttempt.statusCode).toBe(200)
    expect(finalAttempt.json()).toMatchObject({ ok: true, deadLettered: true })

    // Once dead-lettered, a further redelivery (Razorpay would in fact stop
    // sending more once it sees a 2xx, but a straggler in flight is
    // possible) is acknowledged the same way, not resurrected into another
    // 500.
    const afterDeadLetter = await deliver()
    expect(afterDeadLetter.statusCode).toBe(200)
    expect(afterDeadLetter.json()).toMatchObject({ ok: true, deadLettered: true })

    const [row] = await db.select().from(webhookDeadLetters).where(eq(webhookDeadLetters.idempotencyKey, `payment.captured:${entityId}`))
    expect(row?.deadLetteredAt).not.toBeNull()
    expect(row?.attemptCount).toBeGreaterThanOrEqual(WEBHOOK_MAX_ATTEMPTS)
    expect(row?.lastError).toMatch(/InvalidMoneyError|12\.5/)

    // Never auto-repaired into a mismatch — a delivery this handler could
    // never even parse never reached the reconciliation comparison at all.
    const trail = await db.select().from(events).where(eq(events.bookingId, held.bookingId))
    expect(trail.some((e) => e.type === 'RECONCILIATION_MISMATCH')).toBe(false)
  })
})

function validPolicyBody(overrides: Partial<SetPolicyCommand> = {}): SetPolicyCommand {
  return {
    depositAmountPaise: 30_000,
    cancellationLadder: [
      { hoursBefore: 48, retainPct: 0 },
      { hoursBefore: 12, retainPct: 50 },
      { hoursBefore: 0, retainPct: 100 },
    ],
    noShowFeePaise: 40_000,
    noShowGraceMinutes: 15,
    holdTtlSeconds: 600,
    maxConcurrentHoldsPerAgent: 3,
    holdRateLimitPerMinute: 10,
    ...overrides,
  }
}

describe('merchant API — GET/POST /policy, dev-logs/015 (originally cut, reinstated)', () => {
  it('GET /policy rejects a request with no Authorization header', async () => {
    const response = await policyApp.inject({ method: 'GET', url: '/policy' })
    expect(response.statusCode).toBe(401)
  })

  it('GET /policy 404s before any policy has ever been published for this merchant', async () => {
    const response = await policyApp.inject({ method: 'GET', url: '/policy', headers: { authorization: `Bearer ${POLICY_MERCHANT_TOKEN}` } })
    expect(response.statusCode).toBe(404)
  })

  it('POST /policy rejects a request with no Authorization header', async () => {
    const response = await policyApp.inject({ method: 'POST', url: '/policy', payload: validPolicyBody() })
    expect(response.statusCode).toBe(401)
  })

  it('POST /policy rejects a request with the wrong token', async () => {
    const response = await policyApp.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: 'Bearer not-the-real-token' },
      payload: validPolicyBody(),
    })
    expect(response.statusCode).toBe(401)
  })

  it('with the correct merchant token, publishes version 1 and GET /policy then returns it', async () => {
    const publish = await policyApp.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: `Bearer ${POLICY_MERCHANT_TOKEN}` },
      payload: validPolicyBody(),
    })
    expect(publish.statusCode).toBe(200)
    expect(publish.json()).toMatchObject({ policy: { policyVersion: 1, depositAmountPaise: 30_000 } })

    const read = await policyApp.inject({ method: 'GET', url: '/policy', headers: { authorization: `Bearer ${POLICY_MERCHANT_TOKEN}` } })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({ policy: { policyVersion: 1 } })
  })

  it('a second publish becomes version 2 — an INSERT, not an UPDATE of version 1', async () => {
    const publish = await policyApp.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: `Bearer ${POLICY_MERCHANT_TOKEN}` },
      payload: validPolicyBody({ depositAmountPaise: 50_000 }),
    })
    expect(publish.statusCode).toBe(200)
    expect(publish.json()).toMatchObject({ policy: { policyVersion: 2, depositAmountPaise: 50_000 } })

    const stillV1 = await policyDeps.catalogRepo.getPolicyVersion(POLICY_TEST_MERCHANT_ID, 1)
    expect(stillV1).toMatchObject({ policyVersion: 1, depositAmountPaise: 30_000 })
  })

  it('422s a ladder missing the floor tier, with the specific validation code — and does not publish a new version', async () => {
    const before = await policyDeps.catalogRepo.getActivePolicy(POLICY_TEST_MERCHANT_ID)
    const response = await policyApp.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: `Bearer ${POLICY_MERCHANT_TOKEN}` },
      payload: validPolicyBody({ cancellationLadder: [{ hoursBefore: 48, retainPct: 0 }] }),
    })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'LADDER_MISSING_FLOOR_TIER' })

    const after = await policyDeps.catalogRepo.getActivePolicy(POLICY_TEST_MERCHANT_ID)
    expect(after?.policyVersion).toBe(before?.policyVersion)
  })

  it('422s retention that decreases closer to the appointment', async () => {
    const response = await policyApp.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: `Bearer ${POLICY_MERCHANT_TOKEN}` },
      payload: validPolicyBody({
        cancellationLadder: [
          { hoursBefore: 48, retainPct: 50 },
          { hoursBefore: 0, retainPct: 20 },
        ],
      }),
    })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'LADDER_RETAIN_PCT_NOT_MONOTONIC' })
  })

  it('400s a request missing a required field, before it ever reaches setPolicy', async () => {
    // holdTtlSeconds, not noShowFeePaise — this task made the no-show fee
    // itself optional at the wire schema (see the next test), so omitting
    // *that* field is a legitimate 200 now, not a 400.
    const { holdTtlSeconds: _omit, ...incomplete } = validPolicyBody()
    const response = await policyApp.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: `Bearer ${POLICY_MERCHANT_TOKEN}` },
      payload: incomplete,
    })
    expect(response.statusCode).toBe(400)
  })

  it('publishes successfully when the no-show fee is omitted entirely — it is optional now', async () => {
    const { noShowFeePaise: _fee, noShowGraceMinutes: _grace, ...withoutNoShow } = validPolicyBody({ depositAmountPaise: 25_000 })
    const response = await policyApp.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: `Bearer ${POLICY_MERCHANT_TOKEN}` },
      payload: withoutNoShow,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { policy: { noShowFeePaise?: number; noShowGraceMinutes?: number } }
    expect(body.policy.noShowFeePaise).toBeUndefined()
    expect(body.policy.noShowGraceMinutes).toBeUndefined()
  })

  it('422s when only one of the no-show pair is set', async () => {
    const { noShowGraceMinutes: _grace, ...halfConfigured } = validPolicyBody()
    const response = await policyApp.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: `Bearer ${POLICY_MERCHANT_TOKEN}` },
      payload: halfConfigured,
    })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'NO_SHOW_FIELDS_MUST_BE_PAIRED' })
  })

  it('a smuggled policyVersion field in the request body is ignored — the server still derives its own', async () => {
    const before = await policyDeps.catalogRepo.getActivePolicy(POLICY_TEST_MERCHANT_ID)
    const response = await policyApp.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: `Bearer ${POLICY_MERCHANT_TOKEN}` },
      payload: { ...validPolicyBody(), policyVersion: 999 },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { policy: { policyVersion: number } }
    expect(body.policy.policyVersion).toBe((before?.policyVersion ?? 0) + 1)
    expect(body.policy.policyVersion).not.toBe(999)
  })
})
