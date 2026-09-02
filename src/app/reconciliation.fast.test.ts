import { describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createNoopLogger } from '../adapters/observability/noop-logger.js'
import { FakeCatalogRepo } from '../adapters/db/fake-catalog-repo.js'
import { FakeEventStore } from '../adapters/db/fake-event-store.js'
import { FakeIdempotencyStore } from '../adapters/db/fake-idempotency-store.js'
import { FakeWebhookDeadLetterStore } from '../adapters/db/fake-webhook-dead-letter-store.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import { toPaise } from '../domain/money.js'
import type { WorkingHours } from '../domain/slots.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { requireConfirmed } from './confirm-with-deposit-test-support.js'
import { holdSlot } from './hold-slot.js'
import { reconcileObservedPayment } from './reconciliation.js'
import type { AppDeps } from './types.js'

/**
 * Reproduces the live-production false alarm: a `payment.authorized`
 * webhook for the session-complete leg, redelivered (or simply arriving
 * late) after the booking's own finalize already recorded it as
 * `SESSION_COMPLETE_AUTHORIZATION_HELD` and cleared `pendingPaymentLegs` —
 * `isRecordedAnywhere` only checked the historical, no-show-only
 * `AUTHORIZATION_HELD` event type, never the live
 * `SESSION_COMPLETE_AUTHORIZATION_HELD` one, so a payment that was in fact
 * fully recorded was reported as `unrecorded_payment`.
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

function buildDeps(): AppDeps {
  const clock = new FrozenClock(NOW)
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
  return {
    clock,
    logger: createNoopLogger(),
    paymentCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 60_000 }),
    eventStore: new FakeEventStore(),
    catalogRepo,
    paymentProvider: new FakePaymentProvider(),
    paymentRail: new FakePaymentRail(),
    idempotencyStore: new FakeIdempotencyStore(),
    merchantId: MERCHANT_ID,
    reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 60_000 }),
    webhookDeadLetterStore: new FakeWebhookDeadLetterStore(),
  }
}

let keyCounter = 0
function freshKey(): string {
  keyCounter++
  return `k_${keyCounter}`
}

describe('reconcileObservedPayment — session-complete authorization leg', () => {
  it('does not flag a payment.authorized webhook that arrives after the booking already recorded SESSION_COMPLETE_AUTHORIZATION_HELD for it', async () => {
    const deps = buildDeps()
    const held = await holdSlot(
      { agentId: 'agent_1', practitionerId: PRACTITIONER_ID, serviceId: SERVICE_ID, startsAt: new Date('2026-08-25T10:00:00+05:30'), idempotencyKey: freshKey() },
      deps,
    )
    const result = requireConfirmed(await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: freshKey() }, deps))
    const authorizationId = result.sessionCompleteMandate?.authorizationId
    expect(authorizationId).toBeDefined()

    const { mismatch } = await reconcileObservedPayment(
      held.bookingId,
      { razorpayId: authorizationId!, status: 'authorized', amountPaise: toPaise(result.sessionCompleteMandate!.amountPaise) },
      deps,
    )
    expect(mismatch).toBe(false)

    const trail = await deps.eventStore.loadEvents(held.bookingId)
    expect(trail.some((e) => e.type === 'RECONCILIATION_MISMATCH')).toBe(false)
  })
})
