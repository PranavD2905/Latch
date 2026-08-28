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
import { PaymentRailError, type AuthorizeParams, type AuthorizeResult, type CaptureAuthorizationParams, type CaptureAuthorizationResult, type PaymentRail } from '../ports/payment-rail.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import { reconcileObservedPayment } from './reconciliation.js'
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
 * Wraps a real `PaymentRail` so `authorize` throws for one specific
 * idempotency key while every other call (including `captureDeposit` on the
 * separate `PaymentProvider` port `confirmWithDeposit` calls concurrently —
 * dev-logs/001, docs/01-architecture.md Idea 3) behaves normally. This is
 * the shape of a real partial outage: one leg of a payment provider's API
 * degrades while another (or another provider entirely) stays healthy —
 * `PaymentRailError` mirrors what `ManualCaptureRail` itself throws for an
 * unexpected Razorpay SDK failure (`src/adapters/payment/manual-capture-rail.ts`,
 * dev-logs/006), not a synthetic error type invented for this test.
 */
function railThatFailsAuthorizeFor(real: PaymentRail, failingKey: string): PaymentRail {
  return {
    name: real.name,
    authorize: async (params: AuthorizeParams): Promise<AuthorizeResult> => {
      if (params.idempotencyKey === failingKey) {
        throw new PaymentRailError(params.reference, new Error('simulated no-show-authorization outage'))
      }
      return real.authorize(params)
    },
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
 * dev-logs/016 (SDE3-review follow-up), the "payment-provider outage" chaos
 * scenario the review named. `confirm_with_deposit` runs the deposit capture
 * and the no-show authorisation *concurrently* (`Promise.all`,
 * `confirm-with-deposit.ts`) — deliberately, so a human waiting on both
 * Checkout completions isn't waiting on them serially. That means a partial
 * outage — one leg succeeds, the other fails — is a real, reachable state,
 * not a hypothetical: exactly the shape dev-logs/014 item 2 described but
 * never actually drove through `confirm_with_deposit` itself (its own tests
 * simulate a mismatch by calling the provider/rail directly, bypassing the
 * command that would actually produce this in production). This test drives
 * the real command, hits the real partial failure, and then proves the real
 * mitigation (the webhook path) actually closes it — not just that the
 * claim reads plausibly in a dev log.
 */
describe('chaos: a payment-provider outage mid confirm_with_deposit', () => {
  it('deposit captured, no-show authorization outage: booking stays HELD, the deposit is genuinely unrecorded, and the webhook path is what recovers it', async () => {
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

    await expect(
      confirmWithDeposit({ bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: failingIdempotencyKey }, deps),
    ).rejects.toThrow(PaymentRailError)

    // The booking is left exactly where confirm_with_deposit's own
    // discipline (dev-logs/013) leaves any leg failure: still HELD, not
    // corrupted, not silently CONFIRMED with half the money events missing.
    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshot?.status).toBe('HELD')

    // The actual gap: captureDeposit really did succeed (real money moved,
    // in FakePaymentProvider's own bookkeeping) but Promise.all's rejection
    // on the authorize leg meant the second transaction — the only place
    // DEPOSIT_CAPTURED is ever appended — never ran. The trail has nothing
    // to show for a deposit that, in this test's fake stand-in for Razorpay,
    // genuinely happened.
    const trailBeforeWebhook = await db.select().from(events).where(eq(events.bookingId, held.bookingId))
    expect(trailBeforeWebhook.some((e) => e.type === 'DEPOSIT_CAPTURED')).toBe(false)

    // Replays the exact same capture confirm_with_deposit's own Promise.all
    // already performed — FakePaymentProvider honours idempotency at the
    // provider level (its own doc comment), so this is reading back what
    // really happened, not charging a second time. This is how the test
    // recovers the real `paymentId` a real Razorpay webhook payload would
    // have carried, without confirm_with_deposit having had anywhere to put
    // it in the trail.
    const replayedCapture = await paymentProvider.captureDeposit({ amountPaise: policyResult.policy.depositAmountPaise, idempotencyKey: failingIdempotencyKey, reference: held.bookingId })
    const depositStatus = await paymentProvider.fetchPaymentStatus(replayedCapture.paymentId)
    expect(depositStatus.status).toBe('captured') // confirms the outage genuinely left a captured, unrecorded deposit sitting at the provider

    // dev-logs/014 item 2's own claim, pinned by a real test for the first
    // time: the webhook's real-time path — not the periodic worker, which
    // only scans CONFIRMED bookings — is what notices a HELD booking with a
    // captured deposit Razorpay knows about that the trail doesn't.
    const { mismatch } = await reconcileObservedPayment(held.bookingId, { razorpayId: replayedCapture.paymentId, status: 'captured', amountPaise: policyResult.policy.depositAmountPaise }, deps)
    expect(mismatch).toBe(true)

    const trailAfterWebhook = await db.select().from(events).where(eq(events.bookingId, held.bookingId))
    const finding = trailAfterWebhook.find((e) => e.type === 'RECONCILIATION_MISMATCH')
    expect(finding?.payload).toMatchObject({ subject: 'unrecorded_payment', expectedStatus: 'not_recorded', actualStatus: 'captured', detectedVia: 'webhook' })

    // Never auto-repaired into CONFIRMED — reporting a disagreement is not
    // the same as resolving one (dev-logs/014's "report, don't auto-repair").
    const snapshotAfter = await deps.eventStore.loadSnapshot(held.bookingId)
    expect(snapshotAfter?.status).toBe('HELD')
  })
})
