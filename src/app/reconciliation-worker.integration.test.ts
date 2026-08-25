import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toPaise } from '../domain/money.js'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
import { bookings, events } from '../adapters/db/schema.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../adapters/db/seed-data.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
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
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider,
  paymentRail,
  idempotencyStore: new PostgresIdempotencyStore(db),
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

async function confirmedBooking(hhmm: string): Promise<{ bookingId: string; authorizationId: string; paymentId: string }> {
  const startsAt = slotAt(hhmm)
  clock.set(new Date(startsAt.getTime() - 5 * 24 * 3_600_000))
  const agentId = `agent_${ulid()}`
  const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
  createdBookingIds.push(held.bookingId)
  const policyResult = await getPolicy(deps)
  const confirmed = await confirmWithDeposit(
    { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() },
    deps,
  )
  return { bookingId: held.bookingId, authorizationId: confirmed.authorization.authorizationId, paymentId: confirmed.deposit.paymentId }
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

  it('reports an authorization mismatch when Razorpay shows it captured but the trail (CONFIRMED, not yet charged) still expects it authorized', async () => {
    const { bookingId, authorizationId } = await confirmedBooking('10:00')

    // Simulate the no-show fee being captured outside charge_no_show's own
    // gate (e.g. a direct dashboard capture) — status stays CONFIRMED, but
    // Razorpay's own record has moved past what the trail expects.
    await deps.paymentRail.captureAuthorization({ authorizationId, amountPaise: toPaise(40000), reference: bookingId })

    const { mismatchedBookingIds } = await runReconciliationWorker(deps)
    expect(mismatchedBookingIds).toContain(bookingId)

    const trail = await db.select().from(events).where(eq(events.bookingId, bookingId))
    const mismatch = trail.find((e) => e.type === 'RECONCILIATION_MISMATCH')
    expect(mismatch?.payload).toMatchObject({ subject: 'authorization', expectedStatus: 'authorized', actualStatus: 'captured' })
  })

  it('reconcileObservedPayment (the webhook path) finds nothing to report once the trail already explains the payment', async () => {
    const { bookingId, paymentId } = await confirmedBooking('10:30')
    const { mismatch } = await reconcileObservedPayment(bookingId, { razorpayId: paymentId, status: 'captured', amountPaise: toPaise(30000) }, deps)
    expect(mismatch).toBe(false)
  })
})
