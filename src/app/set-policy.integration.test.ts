import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
import { merchants, policies } from '../adapters/db/schema.js'
import { deletePoliciesForTest } from '../adapters/db/policy-test-cleanup.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import { PolicyValidationError } from '../domain/policy-validation.js'
import { PolicyVersionConflictError } from '../ports/catalog-repo.js'
import { setPolicy, type SetPolicyCommand } from './set-policy.js'
import type { AppDeps } from './types.js'

/**
 * `set_policy`'s write path — publish-as-INSERT, server-derived versioning,
 * and the concurrent-double-publish backstop. docs/03-domain-model.md §2.
 *
 * Runs against a merchant created just for this file, not `SEED_MERCHANT_ID`
 * — publishing new policy versions changes which version `getActivePolicy`
 * returns, and this repo's own convention (dev-logs/013) is that several
 * Claude Code sessions can share one local Postgres at once. An isolated
 * merchant means these tests can never perturb `mer_clinic`'s active policy
 * out from under an unrelated test file or session running concurrently.
 */

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))
const TEST_MERCHANT_ID = `mer_test_setpolicy_${ulid()}`

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
  merchantId: TEST_MERCHANT_ID,
}

function validCommand(overrides: Partial<SetPolicyCommand> = {}): SetPolicyCommand {
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

beforeAll(async () => {
  await db.insert(merchants).values({
    merchantId: TEST_MERCHANT_ID,
    name: 'set_policy test merchant',
    razorpayAccountId: 'acc_test',
    createdAt: new Date(),
  })
})

afterAll(async () => {
  await deletePoliciesForTest(db, eq(policies.merchantId, TEST_MERCHANT_ID))
  await db.delete(merchants).where(eq(merchants.merchantId, TEST_MERCHANT_ID))
  await sql.end()
})

describe('set_policy — publish is an INSERT, version is server-derived', () => {
  it('publishing against a merchant with no policy at all starts at version 1', async () => {
    const result = await setPolicy(validCommand(), deps)
    expect(result.policy.policyVersion).toBe(1)
  })

  it('a second publish becomes version 2, and never touches the version-1 row', async () => {
    const before = await deps.catalogRepo.getPolicyVersion(TEST_MERCHANT_ID, 1)
    expect(before).toBeDefined()

    const second = await setPolicy(validCommand({ depositAmountPaise: 50_000, noShowFeePaise: 60_000 }), deps)
    expect(second.policy.policyVersion).toBe(2)
    expect(second.policy.depositAmountPaise).toBe(50_000)

    // The old version, read fresh from the database, is byte-identical to
    // what it was before v2 was published — the functional half of "publish
    // is an INSERT, never an UPDATE."
    const after = await deps.catalogRepo.getPolicyVersion(TEST_MERCHANT_ID, 1)
    expect(after).toEqual(before)

    // getActivePolicy now returns the new version — v1's row still exists
    // (asserted above), it's just no longer the active one.
    const active = await deps.catalogRepo.getActivePolicy(TEST_MERCHANT_ID)
    expect(active?.policyVersion).toBe(2)
  })

  it('the structural half: nowhere does the adapter UPDATE the policies table', () => {
    const source = readFileSync(fileURLToPath(new URL('../adapters/db/postgres-catalog-repo.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/\.update\(\s*policies\s*\)/)
  })

  it('a client-supplied version field is structurally impossible to honour — SetPolicyCommand has none, and a smuggled one is ignored', async () => {
    const activeBefore = await deps.catalogRepo.getActivePolicy(TEST_MERCHANT_ID)
    const smuggled = { ...validCommand(), policyVersion: 999 }
    const result = await setPolicy(smuggled as SetPolicyCommand, deps)
    expect(result.policy.policyVersion).toBe((activeBefore?.policyVersion ?? 0) + 1)
    expect(result.policy.policyVersion).not.toBe(999)
  })

  it('rejects an invalid publish before writing anything — the active version is unchanged after a validation failure', async () => {
    const activeBefore = await deps.catalogRepo.getActivePolicy(TEST_MERCHANT_ID)
    const invalid = validCommand({ cancellationLadder: [{ hoursBefore: 48, retainPct: 0 }] }) // no floor tier

    await expect(setPolicy(invalid, deps)).rejects.toBeInstanceOf(PolicyValidationError)

    const activeAfter = await deps.catalogRepo.getActivePolicy(TEST_MERCHANT_ID)
    expect(activeAfter?.policyVersion).toBe(activeBefore?.policyVersion)
  })

  it('concurrent publishes never produce a duplicate version — every winner gets a distinct version, every loser is refused cleanly', async () => {
    // N genuinely concurrent calls can legitimately produce more than one
    // winner: with a pooled connection and real async I/O, some calls fully
    // complete (read + insert) before others even start their read, and each
    // of those is a perfectly valid publish against whatever was active at
    // that moment — that's not a race, it's ordinary sequential use. What
    // must never happen, no matter how the scheduler interleaves these, is
    // two calls landing on the *same* version number. That's what this test
    // asserts, rather than assuming only one call can ever win.
    const activeBefore = await deps.catalogRepo.getActivePolicy(TEST_MERCHANT_ID)
    const startVersion = activeBefore?.policyVersion ?? 0
    const N = 8

    const outcomes = await Promise.allSettled(Array.from({ length: N }, (_, i) => setPolicy(validCommand({ noShowGraceMinutes: 10 + i }), deps)))

    const fulfilled = outcomes.filter((o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof setPolicy>>> => o.status === 'fulfilled')
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected')

    expect(fulfilled.length + rejected.length).toBe(N)
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    // N=8 concurrent calls against a real Postgres reliably produces at
    // least one genuine collision — this asserts the conflict path was
    // actually exercised, not just theoretically reachable.
    expect(rejected.length).toBeGreaterThan(0)

    // Every rejection is the clean, typed refusal — never an unhandled
    // Postgres error leaking past the adapter.
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(PolicyVersionConflictError)
    }

    // No two winners share a version — the actual data-integrity property.
    // Because each winner's version is always "whatever was active at its
    // own read" + 1, the set of winning versions is exactly the contiguous
    // run immediately after startVersion, with no duplicates and no gaps.
    const versions = fulfilled.map((f) => f.value.policy.policyVersion).sort((a, b) => a - b)
    expect(new Set(versions).size).toBe(versions.length)
    const expected = Array.from({ length: fulfilled.length }, (_, i) => startVersion + 1 + i)
    expect(versions).toEqual(expected)

    // The active version ends exactly where the winners left it — never
    // ahead by more than the number of calls that actually succeeded.
    const activeAfter = await deps.catalogRepo.getActivePolicy(TEST_MERCHANT_ID)
    expect(activeAfter?.policyVersion).toBe(startVersion + fulfilled.length)
  })
})
