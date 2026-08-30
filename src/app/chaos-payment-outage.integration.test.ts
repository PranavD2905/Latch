import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createNoopLogger } from '../adapters/observability/noop-logger.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
import { PostgresWebhookDeadLetterStore } from '../adapters/db/postgres-webhook-dead-letter-store.js'
import { bookings, events } from '../adapters/db/schema.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../adapters/db/seed-data.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import {
  PaymentRailError,
  type AuthorizationOrder,
  type AuthorizeParams,
  type AuthorizeResult,
  type CaptureAuthorizationParams,
  type CaptureAuthorizationResult,
  type PaymentRail,
} from '../ports/payment-rail.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { requireConfirmed } from './confirm-with-deposit-test-support.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import type { AppDeps } from './types.js'

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))

// Wednesday 2026-09-23, a day no other integration-test file books against.
const BASE_DAY = '2026-09-23'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}
function freshKey(): string {
  return `test_${ulid()}`
}

const createdBookingIds: string[] = []

/**
 * Wraps a real `PaymentRail` so `ensureAuthorizationOrder` throws for one
 * specific idempotency key while every other call (including the deposit
 * leg on the separate `PaymentProvider` port `confirmWithDeposit` calls
 * concurrently — dev-logs/001, docs/01-architecture.md Idea 3) behaves
 * normally. This is the shape of a real partial outage: one leg of a
 * payment provider's API degrades while another (or another provider
 * entirely) stays healthy — `PaymentRailError` mirrors what
 * `ManualCaptureRail` itself throws for an unexpected Razorpay SDK failure
 * (`src/adapters/payment/manual-capture-rail.ts`, dev-logs/006), not a
 * synthetic error type invented for this test. Failing at order creation
 * (rather than the poll) is the earliest point a real outage could hit this
 * leg — `confirm-with-deposit.ts` treats either failure the same way.
 */
function railThatFailsAuthorizeFor(real: PaymentRail, failingKey: string): PaymentRail {
  return {
    name: real.name,
    ensureAuthorizationOrder: async (params: AuthorizeParams): Promise<AuthorizationOrder> => {
      if (params.idempotencyKey === failingKey) {
        throw new PaymentRailError(params.reference, new Error('simulated no-show-authorization outage'))
      }
      return real.ensureAuthorizationOrder(params)
    },
    pollAuthorization: (order: AuthorizationOrder, reference: string, now: Date, options?: { timeoutMs?: number }): Promise<AuthorizeResult | undefined> =>
      real.pollAuthorization(order, reference, now, options),
    captureAuthorization: (params: CaptureAuthorizationParams): Promise<CaptureAuthorizationResult> => real.captureAuthorization(params),
    fetchAuthorizationStatus: (authorizationId: string) => real.fetchAuthorizationStatus(authorizationId),
  }
}

beforeAll(async () => {
  const policy = await new PostgresCatalogRepo(db).getActivePolicy(SEED_MERCHANT_ID)
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

/**
 * dev-logs/016 (SDE3-review follow-up) originally wrote this test to *prove*
 * a real gap: `confirm_with_deposit` ran the deposit capture and the no-show
 * authorisation concurrently via `Promise.all`, so a partial outage — one
 * leg succeeds, the other fails — was a real, reachable production state,
 * and `Promise.all`'s all-or-nothing rejection discarded the already-settled
 * deposit result along with the failure. The booking was left `HELD` with a
 * captured-but-unrecorded deposit, recoverable only via the webhook path.
 *
 * A follow-up architecture review named this as the sharpest, most likely
 * real-world trigger of "the audit trail can diverge from reality" (an
 * ordinary single-leg network blip, not a process crash) and it was closed
 * at the source: `confirm-with-deposit.ts` now uses `Promise.allSettled` and
 * always proceeds to confirm once the mandatory deposit leg succeeds,
 * recording whichever optional legs (no-show auth, session-complete auth)
 * actually landed. This test now proves the fix — the exact same simulated
 * outage that used to strand a captured deposit with zero trail now
 * confirms cleanly, deposit recorded, only the failed leg absent. The
 * webhook/reconciliation path this test used to exercise remains the real
 * mitigation for the narrower case this fix can't reach — a genuine process
 * crash between the payment call returning and the final transaction
 * committing, which no amount of in-process `Promise` handling can help —
 * see dev-logs/014 and `reconciliation.ts`.
 */
describe('chaos: a payment-provider outage mid confirm_with_deposit', () => {
  it('deposit captured, no-show authorization outage: confirm still succeeds, the deposit is recorded, only the failed leg is absent', async () => {
    const paymentProvider = new FakePaymentProvider()
    const realRail = new FakePaymentRail()
    const failingIdempotencyKey = freshKey()
    const flakyRail = railThatFailsAuthorizeFor(realRail, `${failingIdempotencyKey}:no_show_auth`)

    const deps: AppDeps = {
      clock,
      logger: createNoopLogger(),
      paymentCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 60_000 }),
      eventStore: new PostgresEventStore(db),
      catalogRepo: new PostgresCatalogRepo(db),
      paymentProvider,
      paymentRail: flakyRail,
      idempotencyStore: new PostgresIdempotencyStore(db),
      merchantId: SEED_MERCHANT_ID,
      reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 60_000 }),
      webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
    }

    const startsAt = slotAt('11:00')
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)
    const policyResult = await getPolicy(deps)

    // No longer rejects: the no-show leg's outage no longer takes the
    // already-captured deposit down with it.
    const result = requireConfirmed(
      await confirmWithDeposit(
        { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: failingIdempotencyKey },
        deps,
      ),
    )
    expect(result.status).toBe('CONFIRMED')
    expect(result.authorization).toBeUndefined() // the failed leg — absent, not silently retried or faked
    expect(result.sessionCompleteMandate).toBeDefined() // the other, unrelated optional leg — unaffected by the outage

    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('CONFIRMED')
    expect(snapshot?.authorizationId).toBeUndefined()
    expect(snapshot?.sessionCompleteAuthorizationId).toBeDefined()

    // The actual fix, pinned directly: the deposit that really captured (in
    // FakePaymentRail/FakePaymentProvider's own bookkeeping) is genuinely
    // recorded now, not silently dropped by `Promise.all`'s all-or-nothing
    // rejection.
    const trail = await db.select().from(events).where(eq(events.bookingId, held.bookingId))
    expect(trail.some((e) => e.type === 'DEPOSIT_CAPTURED')).toBe(true)
    expect(trail.some((e) => e.type === 'SESSION_COMPLETE_AUTHORIZATION_HELD')).toBe(true)
    expect(trail.some((e) => e.type === 'AUTHORIZATION_HELD')).toBe(false) // the leg that failed — never fabricated
    expect(trail.some((e) => e.type === 'BOOKING_CONFIRMED')).toBe(true)
  })

  it('deposit outage: the mandatory leg failing still rejects and leaves the booking HELD, untouched by the optional-leg fix above', async () => {
    const paymentProvider = new FakePaymentProvider()
    const deps: AppDeps = {
      clock,
      logger: createNoopLogger(),
      paymentCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 60_000 }),
      eventStore: new PostgresEventStore(db),
      catalogRepo: new PostgresCatalogRepo(db),
      paymentProvider,
      paymentRail: new FakePaymentRail(),
      idempotencyStore: new PostgresIdempotencyStore(db),
      merchantId: SEED_MERCHANT_ID,
      reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 60_000 }),
      webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
    }

    const startsAt = slotAt('12:00')
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)
    const policyResult = await getPolicy(deps)

    const depositFailingKey = freshKey()
    paymentProvider.setScenario(depositFailingKey, 'decline')

    await expect(
      confirmWithDeposit({ bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: depositFailingKey }, deps),
    ).rejects.toThrow()

    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('HELD')
    const trail = await db.select().from(events).where(eq(events.bookingId, held.bookingId))
    expect(trail.some((e) => e.type === 'DEPOSIT_CAPTURED')).toBe(false)
  })
})
