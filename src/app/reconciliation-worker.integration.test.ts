import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toPaise } from '../domain/money.js'
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
import type { PaymentProvider } from '../ports/payment-provider.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { requireConfirmed } from './confirm-with-deposit-test-support.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import { reconcileObservedPayment } from './reconciliation.js'
import { runReconciliationWorker } from './reconciliation-worker.js'
import type { AppDeps } from './types.js'

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))
const paymentProvider = new FakePaymentProvider()
const paymentRail = new FakePaymentRail()

const deps: AppDeps = {
  clock,
  logger: createNoopLogger(),
  paymentCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider,
  paymentRail,
  idempotencyStore: new PostgresIdempotencyStore(db),
  reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
  merchantId: SEED_MERCHANT_ID,
}

// Friday 2026-09-18, a day no other integration-test file books against.
const BASE_DAY = '2026-09-18'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}
function freshKey(): string {
  return `test_${ulid()}`
}

const createdBookingIds: string[] = []

async function confirmedBooking(hhmm: string): Promise<{ bookingId: string; paymentId: string }> {
  const startsAt = slotAt(hhmm)
  clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
  const agentId = `agent_${ulid()}`
  const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
  createdBookingIds.push(held.bookingId)
  const policyResult = await getPolicy(deps)
  const confirmed = requireConfirmed(
    await confirmWithDeposit(
      { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() },
      deps,
    ),
  )
  return { bookingId: held.bookingId, paymentId: confirmed.deposit!.paymentId }
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

describe('reconciliation worker (real Postgres) — dev-logs/014 item 1, external verification of the trail', () => {
  it('finds nothing to report for a booking whose trail matches Razorpay exactly', async () => {
    const { bookingId } = await confirmedBooking('09:00')
    const { mismatchedBookingIds } = await runReconciliationWorker(deps)
    expect(mismatchedBookingIds).not.toContain(bookingId)
  })

  it('reports a deposit mismatch when Razorpay shows the payment refunded but the trail still says captured', async () => {
    const { bookingId, paymentId } = await confirmedBooking('09:30')

    // Simulate the deposit being refunded outside Latch's own flow (e.g. a
    // merchant-initiated action directly in the Razorpay dashboard) — the
    // trail was never told, so it still says DEPOSIT_CAPTURED/captured.
    await deps.paymentProvider.refundDeposit({ paymentId, amountPaise: toPaise(30000), idempotencyKey: freshKey(), reference: bookingId })

    const { mismatchedBookingIds } = await runReconciliationWorker(deps)
    expect(mismatchedBookingIds).toContain(bookingId)

    const trail = await db.select().from(events).where(eq(events.bookingId, bookingId))
    const mismatch = trail.find((e) => e.type === 'RECONCILIATION_MISMATCH')
    expect(mismatch?.payload).toMatchObject({ subject: 'deposit', expectedStatus: 'captured', actualStatus: 'refunded', detectedVia: 'periodic_worker' })

    // Running it again immediately does not duplicate the finding — the
    // external state hasn't changed since the last recorded finding.
    await runReconciliationWorker(deps)
    const trailAfter = await db.select().from(events).where(eq(events.bookingId, bookingId))
    expect(trailAfter.filter((e) => e.type === 'RECONCILIATION_MISMATCH')).toHaveLength(1)
  })

  it('reconcileObservedPayment (the webhook path) finds nothing to report once the trail already explains the payment', async () => {
    const { bookingId, paymentId } = await confirmedBooking('10:30')
    const { mismatch } = await reconcileObservedPayment(bookingId, { razorpayId: paymentId, status: 'captured', amountPaise: toPaise(30000) }, deps)
    expect(mismatch).toBe(false)
  })

  it('does not report a still-outstanding payment leg — the trail is silent on purpose until every leg lands', async () => {
    // The payment-link flow hands out up to three pay links and writes
    // nothing until every applicable leg finalizes atomically. So a customer
    // who has paid leg 1 of 3 leaves Razorpay knowing about money the trail
    // has not recorded — which is precisely this function's alarm shape, and
    // precisely what must NOT fire here. Seen live in production: four
    // RECONCILIATION_MISMATCH events on one partially-paid booking, one per
    // worker tick, on a booking that was behaving correctly throughout.
    const startsAt = slotAt('11:30')
    clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    // Nobody has paid the links yet — the state this test is about.
    const confirmKey = freshKey()
    paymentProvider.setScenario(confirmKey, 'pending')
    const result = await confirmWithDeposit(
      { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: (await getPolicy(deps)).policy.policyVersion, idempotencyKey: confirmKey },
      deps,
    )
    expect(result.status).toBe('PENDING')

    const snapshot = await deps.eventStore.loadSnapshot(held.bookingId)
    const leg = snapshot?.pendingPaymentLegs?.[0]
    expect(leg).toBeDefined()

    const inFlight = await reconcileObservedPayment(
      held.bookingId,
      { razorpayId: `pay_inflight_${ulid()}`, orderId: leg!.orderId, status: 'authorized', amountPaise: toPaise(leg!.amountPaise) },
      deps,
    )
    expect(inFlight.mismatch).toBe(false)

    // The suppression stays narrow: a payment on an order this booking never
    // issued is still a genuine unrecorded payment, and is still reported.
    const stray = await reconcileObservedPayment(
      held.bookingId,
      { razorpayId: `pay_stray_${ulid()}`, orderId: 'order_never_issued_here', status: 'authorized', amountPaise: toPaise(30000) },
      deps,
    )
    expect(stray.mismatch).toBe(true)
  })

  // dev-logs/016: the review's "resilient queue... circuit breaker" ask,
  // applied to this worker's own outbound Razorpay calls rather than a new
  // message-queue dependency (docs/02-tech-stack.md §9's "no Redis" reasoning
  // still applies — see the dev log).
  describe('the reconciliation circuit breaker', () => {
    it('stops calling a Razorpay that keeps failing, and never records a failed check as a mismatch', async () => {
      let calls = 0
      const flakyProvider: PaymentProvider = {
        ensureDepositOrder: (p) => paymentProvider.ensureDepositOrder(p),
        pollDepositCapture: (order, reference) => paymentProvider.pollDepositCapture(order, reference),
        refundDeposit: (p) => paymentProvider.refundDeposit(p),
        payDepositViaUpiCollect: (order, vpa, reference, options) => paymentProvider.payDepositViaUpiCollect(order, vpa, reference, options),
        fetchPaymentStatus: async (paymentId) => {
          calls++
          throw new Error(`simulated Razorpay outage for ${paymentId}`)
        },
      }
      const localClock = new FrozenClock(clock.now())
      const breaker = new CircuitBreaker({ name: 'test-outage', clock: localClock, failureThreshold: 3, cooldownMs: 5 * 60_000 })
      const breakerDeps: AppDeps = { ...deps, clock: localClock, paymentProvider: flakyProvider, reconciliationCircuitBreaker: breaker }

      const bookingId = (await confirmedBooking('11:00')).bookingId

      // Deterministically open the breaker first, sequentially, rather than
      // relying on this one candidate's own call to be what trips it — the
      // point of this test is "what does the worker do with an *already*
      // open circuit," not "does N concurrent candidates' raciness happen to
      // trip it inside one tick," which is real but a separate, much
      // noisier claim to pin down deterministically.
      await expect(breaker.execute(() => Promise.reject(new Error('priming failure 1')))).rejects.toThrow()
      await expect(breaker.execute(() => Promise.reject(new Error('priming failure 2')))).rejects.toThrow()
      await expect(breaker.execute(() => Promise.reject(new Error('priming failure 3')))).rejects.toThrow()
      expect(breaker.currentState).toBe('open')

      const result = await runReconciliationWorker(breakerDeps)

      expect(result.circuitOpen).toBe(true)
      // The circuit was already open before the tick started — this
      // candidate's check never even attempted the network call.
      expect(calls).toBe(0)
      // A failed/skipped check is not a disagreement, it's an unanswered
      // question — this worker's whole point is never to guess.
      expect(result.mismatchedBookingIds).not.toContain(bookingId)

      // Not a permanent kill switch: once the cooldown elapses and Razorpay
      // is healthy again (the same breaker instance, the real non-flaky
      // `paymentProvider`), the very next tick recovers on its own.
      localClock.advance(5 * 60_000 + 1)
      const { circuitOpen: stillOpen, mismatchedBookingIds: recovered } = await runReconciliationWorker({ ...breakerDeps, paymentProvider })
      expect(stillOpen).toBe(false)
      expect(recovered).not.toContain(bookingId) // healthy booking, real match — nothing to report either way
    })

    it("one candidate's failing Razorpay call does not discard another candidate's already-good result in the same tick", async () => {
      const { bookingId: healthyBookingId, paymentId } = await confirmedBooking('13:30')
      const { bookingId: mismatchedBookingId, paymentId: refundedPaymentId } = await confirmedBooking('14:00')
      // A real drift Razorpay would actually report, on the second booking only.
      await deps.paymentProvider.refundDeposit({ paymentId: refundedPaymentId, amountPaise: toPaise(30000), idempotencyKey: freshKey(), reference: mismatchedBookingId })

      const realStatus = paymentProvider.fetchPaymentStatus.bind(paymentProvider)
      const flakyProvider: PaymentProvider = {
        ensureDepositOrder: (p) => paymentProvider.ensureDepositOrder(p),
        pollDepositCapture: (order, reference) => paymentProvider.pollDepositCapture(order, reference),
        refundDeposit: (p) => paymentProvider.refundDeposit(p),
        payDepositViaUpiCollect: (order, vpa, reference, options) => paymentProvider.payDepositViaUpiCollect(order, vpa, reference, options),
        fetchPaymentStatus: async (id) => {
          if (id === paymentId) throw new Error('simulated one-off failure for the healthy booking only')
          return realStatus(id)
        },
      }
      const localClock = new FrozenClock(clock.now())
      const partialFailureDeps: AppDeps = {
        ...deps,
        clock: localClock,
        paymentProvider: flakyProvider,
        // A high threshold — this single failure must never trip the
        // breaker; it's testing per-candidate isolation, not the breaker.
        reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test-partial', clock: localClock, failureThreshold: 10, cooldownMs: 60_000 }),
      }

      const { mismatchedBookingIds, circuitOpen } = await runReconciliationWorker(partialFailureDeps)

      expect(circuitOpen).toBe(false)
      expect(mismatchedBookingIds).toContain(mismatchedBookingId)
      expect(mismatchedBookingIds).not.toContain(healthyBookingId)
    })
  })
})
