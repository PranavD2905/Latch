import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createNoopLogger } from '../adapters/observability/noop-logger.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { PostgresWebhookDeadLetterStore } from '../adapters/db/postgres-webhook-dead-letter-store.js'
import { bookings, events, policies } from '../adapters/db/schema.js'
import { deletePoliciesForTest } from '../adapters/db/policy-test-cleanup.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../adapters/db/seed-data.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import { evaluateLadder } from '../domain/ladder.js'
import { floorPercentageOf, subtractPaise } from '../domain/money.js'
import type { AuthorityRef, RetentionAppliedEvent, RefundIssuedEvent } from '../domain/events.js'
import { cancelBooking } from './cancel-booking.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import { setPolicy, type SetPolicyCommand } from './set-policy.js'
import type { AppDeps } from './types.js'

/**
 * **The demo this whole task exists to enable** (dev-logs/015's own brief):
 *
 *   1. Booking made under ladder vN
 *   2. Merchant edits the ladder → vN+1 published
 *   3. New bookings would cite vN+1 — the existing booking still cancels
 *      under vN, and its events still say so
 *
 * docs/03-domain-model.md §2: "A booking made under ladder v4 must be
 * cancelled under ladder v4, even if the merchant has since published v5."
 * Before this task, nothing could publish v5 at all, so this claim was
 * untestable end to end — `cancel_booking`/`confirm_with_deposit` already
 * had the machinery (`CatalogRepo.getPolicyVersion`), it just had no second
 * version to ever be handed.
 *
 * Runs against `SEED_MERCHANT_ID` because it's the only merchant with a real
 * practitioner/service to book against — deliberately reads whatever the
 * seed's current active version actually is rather than hardcoding "v4", and
 * cleans up the one new policy row it creates in `afterAll`, restoring the
 * active version to what it was before this file ran (the same
 * shared-local-Postgres caution `set-policy.integration.test.ts` explains).
 */

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))

const deps: AppDeps = {
  clock,
  logger: createNoopLogger(),
  paymentCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider: new FakePaymentProvider(),
  paymentRail: new FakePaymentRail(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
  merchantId: SEED_MERCHANT_ID,
}

// Wednesday 2026-11-04, a day no other integration-test file books against.
const BASE_DAY = '2026-11-04'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}
function freshKey(): string {
  return `test_${ulid()}`
}

const createdBookingIds: string[] = []
const createdPolicyIds: string[] = []

afterAll(async () => {
  for (const bookingId of createdBookingIds) {
    await db.delete(events).where(eq(events.bookingId, bookingId))
    await db.delete(bookings).where(eq(bookings.bookingId, bookingId))
  }
  for (const policyId of createdPolicyIds) {
    await deletePoliciesForTest(db, eq(policies.policyId, policyId))
  }
  await sql.end()
})

describe('retroactivity: a booking cancels under the policy version it was confirmed under, not whatever is active now', () => {
  it('publishing v(N+1) does not change how a booking confirmed under vN is cancelled', async () => {
    // 1. Book and confirm under whatever the seed's current active version is.
    const startsAt = slotAt('15:00')
    const bookedAt = new Date(startsAt.getTime() - 60 * 3_600_000) // 60h out
    clock.set(bookedAt)

    const originalPolicy = await deps.catalogRepo.getActivePolicy(SEED_MERCHANT_ID)
    if (!originalPolicy) throw new Error('seed data missing — run `npm run db:seed` before this test suite')
    const originalVersion = originalPolicy.policyVersion

    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)

    const confirmed = await confirmWithDeposit(
      { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: originalVersion, idempotencyKey: freshKey() },
      deps,
    )
    expect(confirmed.policyVersion).toBe(originalVersion)

    // 2. The merchant edits the ladder and publishes v(N+1) — a ladder that
    // behaves *differently* at the cancel-time instant this test uses below,
    // so the two versions are actually distinguishable, not coincidentally
    // the same. The new ladder deliberately retains 100% everywhere: if
    // `cancel` ever cited the *new* policy instead of the one the booking
    // was confirmed under, this test would see 100% retention instead of
    // whatever `originalPolicy`'s own ladder produces for this instant.
    const newLadder: SetPolicyCommand = {
      depositAmountPaise: originalPolicy.depositAmountPaise,
      cancellationLadder: [{ hoursBefore: 0, retainPct: 100 }],
      holdTtlSeconds: originalPolicy.holdTtlSeconds,
      maxConcurrentHoldsPerAgent: originalPolicy.maxConcurrentHoldsPerAgent,
      holdRateLimitPerMinute: originalPolicy.holdRateLimitPerMinute,
    }
    const published = await setPolicy(newLadder, deps)
    expect(published.policy.policyVersion).toBe(originalVersion + 1)

    // Track the new row for cleanup now, before anything else in this test
    // can throw and skip it — `Policy` doesn't carry its own `policyId`, so
    // this is the one place we look it up directly.
    const newRows = await db
      .select({ policyId: policies.policyId })
      .from(policies)
      .where(and(eq(policies.merchantId, SEED_MERCHANT_ID), eq(policies.version, originalVersion + 1)))
    if (newRows[0]) createdPolicyIds.push(newRows[0].policyId)

    // New reads now see the new version — this is the "new bookings would
    // cite v(N+1)" half of the demo.
    const currentPolicy = await getPolicy(deps)
    expect(currentPolicy.policy.policyVersion).toBe(originalVersion + 1)

    // 3. Cancel the *original* booking, at an instant chosen only against the
    // original ladder's own maths — this test never hardcodes what
    // `originalVersion`'s retention percentage actually is, so it stays
    // correct no matter what the seed ladder contains.
    const cancelAt = new Date(startsAt.getTime() - 20 * 3_600_000) // 20h before the appointment
    clock.set(cancelAt)
    const expectedLadderResult = evaluateLadder(originalPolicy.cancellationLadder, startsAt, cancelAt)
    const expectedRetained = floorPercentageOf(originalPolicy.depositAmountPaise!, expectedLadderResult.retainPct)
    const expectedRefund = subtractPaise(originalPolicy.depositAmountPaise!, expectedRetained)

    const result = await cancelBooking({ bookingId: held.bookingId, idempotencyKey: freshKey() }, deps)

    // The star assertion: retained/refunded amounts match v(original), not
    // v(original+1)'s "always retain everything."
    expect(result.retained.amountPaise).toBe(expectedRetained)
    expect(result.refund.amountPaise).toBe(expectedRefund)

    // If the ladder had (wrongly) evaluated against the new 100%-retain
    // policy instead, retained would equal the full deposit and refund would
    // be 0 — assert that distinction actually held in this scenario,
    // otherwise the test could pass by accident on a seed ladder that also
    // happens to retain 100% at 20h out.
    expect(result.retained.amountPaise).not.toBe(originalPolicy.depositAmountPaise)

    // 4. And the trail itself says so: every money event this cancel wrote
    // cites the *original* policy version as its authority, never the new one.
    const history = await deps.eventStore.loadEvents(held.bookingId)
    const retention = history.find((e): e is RetentionAppliedEvent => e.type === 'RETENTION_APPLIED')
    const refund = history.find((e): e is RefundIssuedEvent => e.type === 'REFUND_ISSUED')
    const authorities: (AuthorityRef | undefined)[] = [retention?.authority, refund?.authority]
    for (const authority of authorities) {
      if (!authority) continue
      expect(authority.policyVersion).toBe(originalVersion)
      expect(authority.policyVersion).not.toBe(originalVersion + 1)
    }
  })
})
