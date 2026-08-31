import { eq } from 'drizzle-orm'
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
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import type { AppDeps } from './types.js'

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

// Saturday 2026-09-19, a day no other integration-test file books against.
const BASE_DAY = '2026-09-19'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}
function freshKey(): string {
  return `test_${ulid()}`
}

const RATE_LIMIT_TEST_POLICY_VERSION = 998
const createdBookingIds: string[] = []

beforeAll(async () => {
  const currentPolicy = await getPolicy(deps)
  // dev-logs/014, gap 2: publish a policy version whose rate ceiling is low
  // enough to hit deterministically in a handful of calls, and whose
  // concurrent-hold ceiling is deliberately high so that bound never fires
  // first and masks the one this test is actually about.
  await db.insert(policies).values({
    policyId: `pol_test_rate_limit_${ulid()}`,
    merchantId: SEED_MERCHANT_ID,
    version: RATE_LIMIT_TEST_POLICY_VERSION,
    depositType: 'fixed',
    depositAmountPaise: currentPolicy.policy.depositAmountPaise ?? null,
    cancellationLadder: currentPolicy.policy.cancellationLadder,
    holdTtlSeconds: currentPolicy.policy.holdTtlSeconds,
    maxConcurrentHoldsPerAgent: 10,
    holdRateLimitPerMinute: 2,
    createdAt: new Date(),
  })
})

afterAll(async () => {
  await deletePoliciesForTest(db, eq(policies.version, RATE_LIMIT_TEST_POLICY_VERSION))
  for (const bookingId of createdBookingIds) {
    await db.delete(events).where(eq(events.bookingId, bookingId))
    await db.delete(bookings).where(eq(bookings.bookingId, bookingId))
  }
  await sql.end()
})

describe('hold_slot request-rate ceiling (real Postgres) — dev-logs/014, gap 2', () => {
  it('refuses with RATE_LIMITED once an agent exceeds holdRateLimitPerMinute, even with room left on the concurrent-hold ceiling', async () => {
    clock.set(new Date(slotAt('09:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`

    const first = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(first.bookingId)
    const second = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:30'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(second.bookingId)

    // Two successful holds already at the rate ceiling of 2/min — a third
    // distinct slot request from the same agent is refused, well under the
    // concurrent-hold ceiling of 10 this test's policy set deliberately high.
    await expect(
      holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('10:00'), idempotencyKey: freshKey() }, deps),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })

    // The refusal itself is a permanent trail record (docs/03-domain-model.md §4 footnote ★★).
    const allEvents = await db.select().from(events)
    const refusal = allEvents.find((e) => e.type === 'ACTION_REFUSED' && (e.payload as { refusalCode?: string }).refusalCode === 'RATE_LIMITED')
    expect(refusal).toBeDefined()

    // A different agent, same window, is unaffected — the ceiling is per-agent.
    const otherAgent = `agent_${ulid()}`
    const third = await holdSlot(
      { agentId: otherAgent, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('10:30'), idempotencyKey: freshKey() },
      deps,
    )
    createdBookingIds.push(third.bookingId)
    expect(third.status).toBe('HELD')
  })

  it('the seeded production policy (pol_v4) carries a real, positive holdRateLimitPerMinute — not left at a schema default nobody chose', async () => {
    const policy = await getPolicy(deps)
    expect(policy.policy.holdRateLimitPerMinute).toBeGreaterThan(0)
  })
})
