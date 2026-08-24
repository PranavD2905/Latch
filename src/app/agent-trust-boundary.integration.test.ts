import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createDbClient } from '../adapters/db/client.js'
import { PostgresCatalogRepo } from '../adapters/db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../adapters/db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../adapters/db/postgres-idempotency-store.js'
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
 * three, plus a merchant-API-level check that "set policy" has no live path
 * at all (not even merchant-authenticated) — the features doc names it as a
 * declared non-goal, so proving its absence closes the trust-table row
 * completely rather than just at the agent's own surface.
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
  it('no live route — agent-facing or merchant-authenticated — can set the merchant policy', async () => {
    const app = createMerchantApiServer(deps, { merchantToken: 'irrelevant-for-this-check' })
    // Even with a well-formed bearer token, there is no /policy route to hit —
    // "set_policy" was never built (docs/04-features-and-limitations.md §1.3:
    // "enough to decline a booking and mark non-attendance," nothing more).
    const response = await app.inject({
      method: 'POST',
      url: '/policy',
      headers: { authorization: 'Bearer irrelevant-for-this-check' },
      payload: { depositAmountPaise: 1 },
    })
    expect(response.statusCode).toBe(404)
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
