import { describe, expect, it, vi } from 'vitest'
import { FrozenClock } from '../clock/frozen-clock.js'
import { createNoopLogger } from '../observability/noop-logger.js'
import { CircuitBreaker } from '../../app/circuit-breaker.js'
import { confirmWithDeposit } from '../../app/confirm-with-deposit.js'
import { holdSlot } from '../../app/hold-slot.js'
import type { AppDeps } from '../../app/types.js'
import type { MerchantAuthStore } from '../../ports/merchant-auth.js'
import { toPaise } from '../../domain/money.js'
import type { WorkingHours } from '../../domain/slots.js'
import { FakeCatalogRepo } from '../db/fake-catalog-repo.js'
import { FakeEventStore } from '../db/fake-event-store.js'
import { FakeIdempotencyStore } from '../db/fake-idempotency-store.js'
import { FakeWebhookDeadLetterStore } from '../db/fake-webhook-dead-letter-store.js'
import { FakePaymentProvider } from '../payment/fake-payment-provider.js'
import { FakePaymentRail } from '../payment/fake-payment-rail.js'
import { createAuditTrailServer } from './server.js'

/**
 * The gap this file exists to close: `hold-expiry-worker.ts` reclaims a
 * lapsed hold on its own tick, but between the moment a hold actually lapses
 * (by the server clock) and that tick, `status` is still `HELD` in the DB.
 * Before this, `/pay/:bookingId` had no check against that window at all —
 * a customer could pay for a slot that had already, or was about to be,
 * given back to inventory, with the payment landing at Razorpay for real and
 * the booking never resurrected by `finalize-from-webhook.ts` (which
 * deliberately refuses to confirm anything not still `HELD`). `holdIsLive`
 * (`server.ts`) closes it by comparing `holdExpiresAt` directly against
 * `now`, the same test `confirm-with-deposit.ts`'s own gate transaction
 * uses, rather than trusting the worker to have already run.
 *
 * The last `it` below covers a second, separately observed issue: the pay
 * page's Pay button had no disable-on-click guard, so a double-click could
 * fire two POSTs for the same leg. Money was never actually double-charged
 * — verified live against real Razorpay, which stayed at exactly one
 * payment attempt per order either way — but the losing request surfaced a
 * scary generic error even though the other one had already captured it.
 * `checkPendingLegStatus` (`pending-payment-status.ts`) now runs before the
 * S2S submit; a leg Razorpay already shows done short-circuits to a plain
 * redirect instead of racing a second submission.
 */

const NOW = new Date('2026-08-20T00:00:00+05:30')
const MERCHANT_ID = 'mer_test'
const PRACTITIONER_ID = 'prac_test'
const SERVICE_ID = 'svc_test'
const WORKING_HOURS: WorkingHours = {
  mon: [['09:00', '17:00']],
  tue: [['09:00', '17:00']],
  wed: [['09:00', '17:00']],
  thu: [['09:00', '17:00']],
  fri: [['09:00', '17:00']],
}

function buildDeps(clock: FrozenClock): { deps: AppDeps; paymentProvider: FakePaymentProvider } {
  const catalogRepo = new FakeCatalogRepo()
  catalogRepo.setPractitioner({ practitionerId: PRACTITIONER_ID, merchantId: MERCHANT_ID, name: 'Dr Test', workingHours: WORKING_HOURS })
  catalogRepo.setService({ serviceId: SERVICE_ID, merchantId: MERCHANT_ID, name: 'Consult', durationMinutes: 30, pricePaise: toPaise(80000) })
  catalogRepo.seedPolicy(MERCHANT_ID, {
    policyVersion: 1,
    depositAmountPaise: toPaise(30000),
    cancellationLadder: [],
    holdTtlSeconds: 600,
    maxConcurrentHoldsPerAgent: 5,
    holdRateLimitPerMinute: 20,
  })
  const paymentProvider = new FakePaymentProvider()
  const deps: AppDeps = {
    clock,
    logger: createNoopLogger(),
    paymentCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 60_000 }),
    eventStore: new FakeEventStore(),
    catalogRepo,
    paymentProvider,
    paymentRail: new FakePaymentRail(),
    idempotencyStore: new FakeIdempotencyStore(),
    merchantId: MERCHANT_ID,
    reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 60_000 }),
    webhookDeadLetterStore: new FakeWebhookDeadLetterStore(),
  }
  return { deps, paymentProvider }
}

const stubMerchantAuthStore: MerchantAuthStore = {
  verifyToken: async () => undefined,
  issueToken: async () => ({ token: 'unused' }),
}

async function pendingBooking(deps: AppDeps, paymentProvider: FakePaymentProvider) {
  const held = await holdSlot({ agentId: 'agent_1', practitionerId: PRACTITIONER_ID, serviceId: SERVICE_ID, startsAt: new Date('2026-08-25T10:00:00+05:30'), idempotencyKey: 'hold_1' }, deps)
  paymentProvider.setScenario('confirm_1', 'pending')
  const result = await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: 'confirm_1' }, deps)
  if (result.status !== 'PENDING') throw new Error('expected PENDING')
  return held.bookingId
}

describe('audit-trail server — /pay routes, hold-liveness guard', () => {
  it('a live, unexpired hold renders the deposit form normally', async () => {
    const clock = new FrozenClock(NOW)
    const { deps, paymentProvider } = buildDeps(clock)
    const bookingId = await pendingBooking(deps, paymentProvider)
    const app = createAuditTrailServer(deps, { merchantAuthStore: stubMerchantAuthStore })

    const response = await app.inject({ method: 'GET', url: `/pay/${bookingId}` })
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('Nothing to pay here')
    expect(response.body).toContain('₹300 deposit for your booking')
  })

  it('once the hold has lapsed by the server clock, the pay page 404s even though status is still HELD (the worker has not ticked yet)', async () => {
    const clock = new FrozenClock(NOW)
    const { deps, paymentProvider } = buildDeps(clock)
    const bookingId = await pendingBooking(deps, paymentProvider)

    // Past confirm_with_deposit's 5-minute claim window. No hold-expiry-worker
    // run here on purpose — this is exactly the race window the fix closes.
    clock.advance(6 * 60_000)
    expect((await deps.eventStore.loadSnapshot(bookingId))?.status).toBe('HELD')

    const app = createAuditTrailServer(deps, { merchantAuthStore: stubMerchantAuthStore })
    const response = await app.inject({ method: 'GET', url: `/pay/${bookingId}` })
    expect(response.statusCode).toBe(404)
    expect(response.body).toContain('Nothing to pay here')
  })

  it('refuses to submit a UPI payment against a lapsed hold — never reaches the payment provider', async () => {
    const clock = new FrozenClock(NOW)
    const { deps, paymentProvider } = buildDeps(clock)
    const bookingId = await pendingBooking(deps, paymentProvider)
    clock.advance(6 * 60_000)

    const spy = vi.spyOn(paymentProvider, 'payDepositViaUpiCollect')
    const app = createAuditTrailServer(deps, { merchantAuthStore: stubMerchantAuthStore })
    const response = await app.inject({ method: 'POST', url: `/pay/${bookingId}/deposit`, payload: 'vpa=success@razorpay', headers: { 'content-type': 'application/x-www-form-urlencoded' } })

    expect(response.statusCode).toBe(404)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a duplicate POST for an already-captured leg redirects harmlessly instead of submitting a second S2S payment — real observed race, not hypothetical', async () => {
    const clock = new FrozenClock(NOW)
    const { deps, paymentProvider } = buildDeps(clock)
    const bookingId = await pendingBooking(deps, paymentProvider)
    const app = createAuditTrailServer(deps, { merchantAuthStore: stubMerchantAuthStore })

    const first = await app.inject({ method: 'POST', url: `/pay/${bookingId}/deposit`, payload: 'vpa=success@razorpay', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(first.statusCode).toBe(303)
    expect(first.headers.location).not.toContain('error=')

    const spy = vi.spyOn(paymentProvider, 'payDepositViaUpiCollect')
    const second = await app.inject({ method: 'POST', url: `/pay/${bookingId}/deposit`, payload: 'vpa=success@razorpay', headers: { 'content-type': 'application/x-www-form-urlencoded' } })

    expect(second.statusCode).toBe(303)
    expect(second.headers.location).not.toContain('error=')
    expect(spy).not.toHaveBeenCalled()
  })
})
