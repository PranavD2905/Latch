import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { PostgresWebhookDeadLetterStore } from '../adapters/db/postgres-webhook-dead-letter-store.js'
import { PostgresMerchantAuthStore } from '../adapters/db/postgres-merchant-auth.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../adapters/db/seed-data.js'
import { bookings, events } from '../adapters/db/schema.js'
import { createMerchantApiServer } from '../adapters/merchant-api/server.js'
import { FakePaymentProvider } from '../adapters/payment/fake-payment-provider.js'
import { FakePaymentRail } from '../adapters/payment/fake-payment-rail.js'
import { toPaise } from '../domain/money.js'
import { CaptureAmountMismatchError } from '../ports/payment-rail.js'
import { cancelBooking } from './cancel-booking.js'
import { confirmWithDeposit } from './confirm-with-deposit.js'
import { getPolicy } from './get-policy.js'
import { holdSlot } from './hold-slot.js'
import type { AppDeps } from './types.js'

/**
 * prompts/slice-8.md item 5 — docs/01-architecture.md §9's trust table
 * turned into executable assertions: "Third-party agent... Cannot: Set
 * policy, decline, mark non-attendance, exceed authorisation ceiling,
 * assert a timestamp."
 *
 * Two of the six escalation vectors this item names — "trigger a merchant
 * decline" and "mark non-attendance" — are already covered exhaustively,
 * not just spot-checked: `mcp-e2e.integration.test.ts` asserts the MCP tool
 * surface is *exactly* the eight agent tools (`toEqual`, not `toContain`),
 * and there is no `decline`/`mark_no_show`/`set_policy` tool registered in
 * `src/adapters/mcp/server.ts` at all — not gated, structurally absent. A
 * third — "exceed its concurrent-hold limit" — already has a dedicated
 * concurrency test in `booking-flow.integration.test.ts` ("under real
 * concurrent hold_slot calls from one agent, at most
 * maxConcurrentHoldsPerAgent ever succeed"). This file covers the remaining
 * three, plus a merchant-API-level check on `set_policy` itself.
 *
 * **Updated, dev-logs/015**: `set_policy` was cut at Slice 8 time
 * (`docs/04-features-and-limitations.md` §3, item 1) and this file's own test
 * once proved its absence outright — `POST /policy` 404ing even with a valid
 * token. It is reinstated now that the schedule allows it, so the equivalent
 * trust-boundary claim is narrower but still real: the route exists, but
 * still has no agent-facing path to it at all (same MCP-tool-list absence
 * above) and still 401s without the merchant's own token — the credential an
 * agent is never issued.
 */

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const clock = new FrozenClock(new Date('2026-08-25T00:00:00+05:30'))

const deps: AppDeps = {
  clock,
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider: new FakePaymentProvider(),
  paymentRail: new FakePaymentRail(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  reconciliationCircuitBreaker: new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
  webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
  merchantId: SEED_MERCHANT_ID,
}

// Friday 2026-10-02, a day no other integration-test file books against.
const BASE_DAY = '2026-10-02'
function slotAt(hhmm: string): Date {
  return new Date(`${BASE_DAY}T${hhmm}:00+05:30`)
}

const createdBookingIds: string[] = []
function freshKey(): string {
  return `test_${ulid()}`
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

describe('agent trust boundary (docs/01-architecture.md §9)', () => {
  it('set_policy exists now (dev-logs/015), but still cannot be reached without the merchant token — no agent-facing credential unlocks it', async () => {
    // Migration 0011: real per-merchant auth — this test only exercises the
    // no-auth and wrong-token refusal paths, so it never needs to issue a
    // valid credential, only the store to check a presented one against.
    const merchantAuthStore = new PostgresMerchantAuthStore(db)
    const app = createMerchantApiServer(deps, { merchantAuthStore })
    const validBody = {
      depositAmountPaise: 30_000,
      cancellationLadder: [
        { hoursBefore: 48, retainPct: 0 },
        { hoursBefore: 0, retainPct: 100 },
      ],
      noShowFeePaise: 40_000,
      noShowGraceMinutes: 15,
      holdTtlSeconds: 600,
      maxConcurrentHoldsPerAgent: 3,
      holdRateLimitPerMinute: 10,
    }

    // No Authorization header at all — the shape an agent, which is never
    // issued this token, would actually present.
    const noAuth = await app.inject({ method: 'POST', url: '/policy', payload: validBody })
    expect(noAuth.statusCode).toBe(401)

    // A well-formed but wrong bearer token — not a credential an agent could
    // ever forge into the real one.
    const wrongAuth = await app.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: 'Bearer not-the-real-token' },
      payload: validBody,
    })
    expect(wrongAuth.statusCode).toBe(401)

    await app.close()
  })

  it('cancel cannot be steered onto a different cancellation-ladder tier by smuggling an extra timestamp field', async () => {
    // >48h out at the real (server) clock reading — the ladder's 0%-retention tier.
    clock.set(new Date(slotAt('09:00').getTime() - 72 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('09:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)
    const policyResult = await getPolicy(deps)
    await confirmWithDeposit({ bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() }, deps)

    clock.set(new Date(slotAt('09:00').getTime() - 60 * 3_600_000)) // still >48h out — still the 0% tier, from the server's own clock

    // CancelBookingCommand has no timestamp field at all — this constructs
    // the extra field via a plain object (not a typed literal), the way a
    // loosely-validated JSON-RPC body could carry one, to prove the app
    // layer never reads it even if it's present on the wire.
    const smuggledCommand = {
      bookingId: held.bookingId,
      idempotencyKey: freshKey(),
      now: new Date(slotAt('09:00').getTime() - 3_600_000).toISOString(), // 1h out — would be the 100% tier, if honoured
    }
    const result = await cancelBooking(smuggledCommand as Parameters<typeof cancelBooking>[0], deps)

    // The server's own clock decided this, not the smuggled field: 0% retained, a real refund issued.
    expect(result.retained.amountPaise).toBe(0)
    expect(result.refund.amountPaise).toBeGreaterThan(0)
  })

  it('the no-show authorisation ceiling is enforced by the rail itself, not an `if` an agent could route around', async () => {
    clock.set(new Date(slotAt('10:00').getTime() - 5 * 24 * 3_600_000))
    const agentId = `agent_${ulid()}`
    const held = await holdSlot({ agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: slotAt('10:00'), idempotencyKey: freshKey() }, deps)
    createdBookingIds.push(held.bookingId)
    const policyResult = await getPolicy(deps)
    const confirmed = await confirmWithDeposit(
      { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: freshKey() },
      deps,
    )

    // ChargeNoShowCommand (src/app/charge-no-show.ts) has no amountPaise
    // field at all — the amount charged is always re-derived from the
    // booking's own recorded authorization, never a caller input. The only
    // way to even *attempt* an over-ceiling capture is to drive the
    // PaymentRail port directly, exactly what an agent would have to do if
    // it tried to bypass charge_no_show's own command shape — and the rail
    // itself refuses it, the same enforcement point real Razorpay uses
    // (dev-logs/005 constraint 1).
    await expect(
      deps.paymentRail.captureAuthorization({
        authorizationId: confirmed.authorization.authorizationId,
        amountPaise: toPaise(confirmed.authorization.amountPaise + 1),
        reference: held.bookingId,
      }),
    ).rejects.toBeInstanceOf(CaptureAmountMismatchError)

    // No headroom was consumed by the refused attempt — the authorisation is untouched.
    await expect(
      deps.paymentRail.captureAuthorization({
        authorizationId: confirmed.authorization.authorizationId,
        amountPaise: toPaise(confirmed.authorization.amountPaise),
        reference: held.bookingId,
      }),
    ).resolves.toMatchObject({ amountPaise: confirmed.authorization.amountPaise })
  })
})
