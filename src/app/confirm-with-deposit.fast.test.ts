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
import { Refusal } from '../domain/refusals.js'
import type { WorkingHours } from '../domain/slots.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { requireConfirmed } from './confirm-with-deposit-test-support.js'
import { holdSlot } from './hold-slot.js'
import type { AppDeps } from './types.js'

/**
 * dev-logs/016 named the coverage gap this file exists to shrink: 21 of this
 * project's 32 test files were `.integration.test.ts`, requiring a live
 * Postgres, largely because `EventStore`/`IdempotencyStore`/`CatalogRepo`
 * had no fakes the way the payment ports already did. This exercises
 * `confirm_with_deposit`'s gate/refusal logic and the `Promise.allSettled`
 * partial-failure fix entirely against in-memory fakes — no Postgres, no
 * `npm run db:migrate`/`db:seed`, no network. It is deliberately not a
 * replacement for `booking-flow.integration.test.ts`/`chaos-payment-outage.integration.test.ts`:
 * those still own proving the real Postgres row-lock/partial-unique-index
 * behaviour and the real Razorpay-shaped payment adapters actually work.
 * This owns the command's own control flow, which never needed either.
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

function buildDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const clock = overrides.clock ?? new FrozenClock(NOW)
  const catalogRepo = (overrides.catalogRepo as FakeCatalogRepo) ?? new FakeCatalogRepo()
  if (!overrides.catalogRepo) {
    ;(catalogRepo as FakeCatalogRepo).setPractitioner({ practitionerId: PRACTITIONER_ID, merchantId: MERCHANT_ID, name: 'Dr Test', workingHours: WORKING_HOURS })
    ;(catalogRepo as FakeCatalogRepo).setService({ serviceId: SERVICE_ID, merchantId: MERCHANT_ID, name: 'Consult', durationMinutes: 30, pricePaise: toPaise(80000) })
    ;(catalogRepo as FakeCatalogRepo).seedPolicy(MERCHANT_ID, {
      policyVersion: 1,
      depositAmountPaise: toPaise(30000),
      cancellationLadder: [],
      holdTtlSeconds: 600,
      maxConcurrentHoldsPerAgent: 5,
      holdRateLimitPerMinute: 20,
    })
  }
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
    ...overrides,
  }
}

let keyCounter = 0
function freshKey(): string {
  keyCounter++
  return `k_${keyCounter}`
}

async function holdFreshSlot(deps: AppDeps, startsAt: Date) {
  return holdSlot({ agentId: 'agent_1', practitionerId: PRACTITIONER_ID, serviceId: SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
}

describe('confirm_with_deposit — fast, fake-backed gate/refusal coverage', () => {
  it('refuses POLICY_NOT_ACKNOWLEDGED when no acknowledgedPolicyVersion is given', async () => {
    const deps = buildDeps()
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    const attempt = confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: undefined, idempotencyKey: freshKey() }, deps)
    await expect(attempt).rejects.toThrow(Refusal)
    await attempt.catch((err: unknown) => expect((err as Refusal).code).toBe('POLICY_NOT_ACKNOWLEDGED'))
    expect((await deps.eventStore.loadSnapshot(held.bookingId))?.status).toBe('HELD')
  })

  it('refuses POLICY_VERSION_STALE when the acknowledged version does not match the merchant\'s current one', async () => {
    const deps = buildDeps()
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    await expect(
      confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 99, idempotencyKey: freshKey() }, deps),
    ).rejects.toThrow(Refusal)
  })

  it('refuses HOLD_EXPIRED once the hold\'s own TTL has lapsed', async () => {
    const deps = buildDeps()
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    const clock = deps.clock as FrozenClock
    clock.set(new Date(NOW.getTime() + 700_000)) // past holdTtlSeconds (600s)
    await expect(
      confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: freshKey() }, deps),
    ).rejects.toThrow(Refusal)
  })

  it('refuses SERVICE_PRICE_BELOW_DEPOSIT when the service\'s current price cannot cover the deposit', async () => {
    const catalogRepo = new FakeCatalogRepo()
    catalogRepo.setPractitioner({ practitionerId: PRACTITIONER_ID, merchantId: MERCHANT_ID, name: 'Dr Test', workingHours: WORKING_HOURS })
    catalogRepo.setService({ serviceId: SERVICE_ID, merchantId: MERCHANT_ID, name: 'Consult', durationMinutes: 30, pricePaise: toPaise(10000) }) // below the 30000 deposit
    catalogRepo.seedPolicy(MERCHANT_ID, {
      policyVersion: 1,
      depositAmountPaise: toPaise(30000),
      cancellationLadder: [],
      holdTtlSeconds: 600,
      maxConcurrentHoldsPerAgent: 5,
      holdRateLimitPerMinute: 20,
    })
    const deps = buildDeps({ catalogRepo })
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    await expect(
      confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: freshKey() }, deps),
    ).rejects.toThrow(Refusal)
  })

  it('happy path: confirms, captures the deposit, and registers the session-complete authorisation leg', async () => {
    const deps = buildDeps()
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    const result = requireConfirmed(await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: freshKey() }, deps))
    expect(result.status).toBe('CONFIRMED')
    expect(result.deposit!.amountPaise).toBe(30000)
    expect(result.sessionCompleteMandate?.amountPaise).toBe(50000) // 80000 - 30000
    expect((await deps.eventStore.loadSnapshot(held.bookingId))?.status).toBe('CONFIRMED')
  })

  it('replays the stored result for a repeated idempotency key instead of confirming twice', async () => {
    const deps = buildDeps()
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    const key = freshKey()
    const first = await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: key }, deps)
    const second = await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: key }, deps)
    expect(second).toEqual(first)
  })

  it('a failed optional authorization leg no longer strands the already-captured deposit (the Promise.allSettled fix), reproduced without Postgres', async () => {
    const paymentRail = new FakePaymentRail()
    const deps = buildDeps({ paymentRail })
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    const key = freshKey()
    paymentRail.setScenario(`${key}:session_complete_auth`, 'decline')

    const result = requireConfirmed(await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: key }, deps))
    expect(result.status).toBe('CONFIRMED')
    expect(result.deposit).toBeDefined()
    expect(result.sessionCompleteMandate).toBeUndefined()

    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
    expect((await deps.eventStore.loadEvents(held.bookingId)).some((e) => e.type === 'DEPOSIT_CAPTURED')).toBe(true)
  })

  it('the mandatory deposit leg failing still rejects and leaves the booking HELD to retry', async () => {
    const paymentProvider = new FakePaymentProvider()
    const deps = buildDeps({ paymentProvider })
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    const key = freshKey()
    paymentProvider.setScenario(key, 'decline')

    await expect(confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: key }, deps)).rejects.toThrow()
    expect((await deps.eventStore.loadSnapshot(held.bookingId))?.status).toBe('HELD')
  })
})

/**
 * Payment-link feature follow-up (dev-logs entry): one combined pay page,
 * and only the legs the merchant's policy actually calls for. These pin the
 * leg-selection matrix and the PENDING -> pay -> retry -> CONFIRMED
 * conversation the MCP tool descriptions instruct an agent to drive.
 */
describe('confirm_with_deposit — which legs apply, and the PENDING/retry cycle', () => {
  it('returns exactly one payUrl covering every outstanding leg, not one link per leg', async () => {
    const paymentProvider = new FakePaymentProvider()
    const paymentRail = new FakePaymentRail()
    const deps = buildDeps({ paymentProvider, paymentRail })
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    const key = freshKey()
    paymentProvider.setScenario(key, 'pending')
    paymentRail.setScenario(`${key}:session_complete_auth`, 'pending')

    const result = await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: key }, deps)
    expect(result.status).toBe('PENDING')
    if (result.status !== 'PENDING') return
    expect(result.payUrl).toMatch(new RegExp(`/pay/${held.bookingId}$`))
    expect(result.outstanding.map((o) => o.leg)).toEqual(['deposit', 'session_complete_authorization'])
    // Every label is a sentence an agent can say out loud, not an identifier.
    for (const leg of result.outstanding) expect(leg.label).toMatch(/₹/)
    expect((await deps.eventStore.loadSnapshot(held.bookingId))?.status).toBe('HELD') // PENDING is a result shape, never a booking status
  })

  it('a policy with no deposit offers no deposit leg at all — the session-complete mandate is the only leg', async () => {
    const catalogRepo = new FakeCatalogRepo()
    catalogRepo.setPractitioner({ practitionerId: PRACTITIONER_ID, merchantId: MERCHANT_ID, name: 'Dr Test', workingHours: WORKING_HOURS })
    catalogRepo.setService({ serviceId: SERVICE_ID, merchantId: MERCHANT_ID, name: 'Consult', durationMinutes: 30, pricePaise: toPaise(80000) })
    catalogRepo.seedPolicy(MERCHANT_ID, {
      policyVersion: 1,
      depositAmountPaise: undefined, // no upfront deposit at all
      cancellationLadder: [],
      holdTtlSeconds: 600,
      maxConcurrentHoldsPerAgent: 5,
      holdRateLimitPerMinute: 20,
    })
    const paymentRail = new FakePaymentRail()
    const deps = buildDeps({ catalogRepo, paymentRail })
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    const key = freshKey()
    paymentRail.setScenario(`${key}:session_complete_auth`, 'pending')

    const result = await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: key }, deps)
    expect(result.status).toBe('PENDING')
    if (result.status !== 'PENDING') return
    expect(result.outstanding.map((o) => o.leg)).toEqual(['session_complete_authorization'])
    // The whole service price is the session-complete mandate when no deposit is taken.
    expect(result.outstanding.find((o) => o.leg === 'session_complete_authorization')?.amountPaise).toBe(80000)
  })

  it('a no-deposit policy confirms with no DEPOSIT_CAPTURED event and an undefined deposit in the result', async () => {
    const catalogRepo = new FakeCatalogRepo()
    catalogRepo.setPractitioner({ practitionerId: PRACTITIONER_ID, merchantId: MERCHANT_ID, name: 'Dr Test', workingHours: WORKING_HOURS })
    catalogRepo.setService({ serviceId: SERVICE_ID, merchantId: MERCHANT_ID, name: 'Consult', durationMinutes: 30, pricePaise: toPaise(80000) })
    catalogRepo.seedPolicy(MERCHANT_ID, {
      policyVersion: 1,
      depositAmountPaise: undefined,
      cancellationLadder: [],
      holdTtlSeconds: 600,
      maxConcurrentHoldsPerAgent: 5,
      holdRateLimitPerMinute: 20,
    })
    const deps = buildDeps({ catalogRepo })
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))

    const result = requireConfirmed(await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: freshKey() }, deps))
    expect(result.deposit).toBeUndefined()
    expect(result.sessionCompleteMandate?.amountPaise).toBe(80000)

    const trail = await deps.eventStore.loadEvents(held.bookingId)
    expect(trail.some((e) => e.type === 'DEPOSIT_CAPTURED')).toBe(false) // no ₹0 money event, ever
    expect(trail.some((e) => e.type === 'BOOKING_CONFIRMED')).toBe(true)
  })

  it('an optional leg that simply has not been paid yet keeps the booking PENDING rather than confirming without it', async () => {
    const paymentRail = new FakePaymentRail()
    const deps = buildDeps({ paymentRail })
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    const key = freshKey()
    // The deposit lands immediately; only the session-complete mandate lags.
    paymentRail.setScenario(`${key}:session_complete_auth`, 'pending')

    const result = await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: key }, deps)
    expect(result.status).toBe('PENDING')
    if (result.status !== 'PENDING') return
    expect(result.outstanding.map((o) => o.leg)).toEqual(['session_complete_authorization'])
    expect((await deps.eventStore.loadSnapshot(held.bookingId))?.status).toBe('HELD')
  })

  it('the PENDING -> human pays -> retry same key -> CONFIRMED cycle, with no duplicate money events', async () => {
    const paymentProvider = new FakePaymentProvider()
    const paymentRail = new FakePaymentRail()
    const deps = buildDeps({ paymentProvider, paymentRail })
    const held = await holdFreshSlot(deps, new Date('2026-08-25T10:00:00+05:30'))
    const key = freshKey()
    paymentProvider.setScenario(key, 'pending')
    paymentRail.setScenario(`${key}:session_complete_auth`, 'pending')

    const first = await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: key }, deps)
    expect(first.status).toBe('PENDING')

    // The human pays the deposit only — a retry must still report the mandate as outstanding.
    paymentProvider.completeDeposit(key)
    const second = await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: key }, deps)
    expect(second.status).toBe('PENDING')
    if (second.status !== 'PENDING') return
    expect(second.outstanding.map((o) => o.leg)).toEqual(['session_complete_authorization'])

    // Then the rest.
    paymentRail.completeAuthorization(`${key}:session_complete_auth`)
    const third = requireConfirmed(await confirmWithDeposit({ bookingId: held.bookingId, agentId: 'agent_1', acknowledgedPolicyVersion: 1, idempotencyKey: key }, deps))
    expect(third.deposit?.amountPaise).toBe(30000)
    expect(third.sessionCompleteMandate?.amountPaise).toBe(50000)

    const trail = await deps.eventStore.loadEvents(held.bookingId)
    expect(trail.filter((e) => e.type === 'DEPOSIT_CAPTURED')).toHaveLength(1)
    expect(trail.filter((e) => e.type === 'SESSION_COMPLETE_AUTHORIZATION_HELD')).toHaveLength(1)
    expect(trail.filter((e) => e.type === 'BOOKING_CONFIRMED')).toHaveLength(1)
    // Every PENDING round records why the gap exists, for the audit trail.
    expect(trail.filter((e) => e.type === 'PAYMENT_REQUESTED').length).toBeGreaterThanOrEqual(1)
    expect((await deps.eventStore.loadSnapshot(held.bookingId))?.pendingPaymentLegs).toBeUndefined() // cleared on confirm — stale links stop resolving
  })
})
