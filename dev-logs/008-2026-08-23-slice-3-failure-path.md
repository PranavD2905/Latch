# Dev Log 008 — Slice 3: the failure path

**Date:** 23 August 2026
**Phase:** Slice 3 (`prompts/slice-3.md`)
**Status:** Done — all "Done when" acceptance criteria pass under `npm test` (76 tests), including one
assertion against a real Razorpay refund, no mocking

---

## What was built

- **`decline_booking`, a genuinely separate inbound surface.** `src/adapters/merchant-api/` — a small
  Fastify app (`server.ts`) with exactly one route, `POST /bookings/:bookingId/decline`, gated by a
  static bearer-token `onRequest` hook compared against `MERCHANT_API_TOKEN`
  (`docs/02-tech-stack.md`'s "one merchant, one static token"), plus an `http.ts` entrypoint mirroring
  `stdio.ts`'s wiring (`npm run merchant-api:dev` / `:dev:razorpay`). This is what makes "no agent can
  invoke decline_booking" structural rather than a policy an agent could be trusted to respect: an agent
  only ever sees the MCP tool list, which never registers this route — verified by
  `mcp-e2e.integration.test.ts`'s existing exact-match tool-list assertion, still exactly the four Slice
  1 tools. `fastify` is a new real dependency (`docs/02-tech-stack.md` §4's already-chosen HTTP server),
  introduced now rather than waiting for Slice 6/7 because slice-3.md's own "Build this" list names the
  merchant API as item 1 with authentication as an explicit requirement — scoped to exactly this one
  route, not a preview of the viewer or Streamable HTTP work.
- **`declineBooking`** (`src/app/decline-booking.ts`) — the app-layer command. Same two-transaction
  shape dev-logs/004 established for `confirm_with_deposit`: gate-check under `loadSnapshotForUpdate`
  (booking must exist and be `CONFIRMED`), then — strictly outside any row lock — a real
  `paymentProvider.refundDeposit()` call and a `find_slots` calendar query for alternatives, then a
  final transaction appending all five trail events atomically and flipping the projection to
  `DECLINED_BY_MERCHANT`. Idempotency-keyed like every other money-moving command.
- **Cause attribution made structurally impossible to get backwards.** `MerchantDeclinedEvent.cause` is
  typed as the literal `'MERCHANT'`, not the wider `'CUSTOMER' | 'MERCHANT'` union — there is no way to
  construct this event with any other cause, and no `cause` parameter exists anywhere in
  `declineBooking`'s command or the merchant API's request body for a caller to get wrong. The ladder is
  never even imported into `decline-booking.ts`, so it is not "checked and found not to apply" — it is
  physically absent from the code path. `events.test.ts` gained two `@ts-expect-error` cases proving
  this at compile time, mirroring the existing `MoneyFields` guarantee tests.
- **Two new event types**, both additive to the existing catalogue:
  - `SLOT_RELEASED` — referenced in `docs/01-architecture.md` §7 and the `docs/03-domain-model.md` §6
    worked trace, but missing from the §4 catalogue table and from `events.ts`'s original union
    entirely. Same class of gap dev-logs/003 found for `BOOKING_COMPLETED`. Added to both. It does not
    itself change the projection — `MERCHANT_DECLINED` already flips status away from `confirmed` in
    `fold()`, which is what actually frees the partial unique index; `SLOT_RELEASED` is the audit
    record of that fact, not a second mechanism.
  - `AUTHORIZATION_RELEASED` — stubbed per slice-3.md's explicit instruction (`rail`, `note`, no
    `authorizationId`), because no-show authorisation registration is entirely Slice 4 scope; there is
    no real authorisation yet to release. The event still lands in every decline, so Slice 4 only has
    to fill in `authorizationId` and stop stubbing (slice-4.md's own words: "replace the Slice 3 stub")
    — the event type and its place in the five-event transaction are already fixed.
- **`AlternativesOfferedEvent` fixed, not just implemented.** The original catalogue had
  `slotIds: readonly string[]`, but there is no `Slot` table and no slot-id concept anywhere in the
  domain (`docs/03-domain-model.md` §1) — `find_slots` has always returned computed
  `(practitionerId, serviceId, startsAt)` tuples, never an id. Renamed the field to
  `alternatives: readonly { practitionerId; serviceId; startsAt }[]` rather than inventing a fake id
  scheme to match a field name nothing else in the codebase uses.
- **`AuthorityRef.razorpayRefundId?: string` added.** `REFUND_ISSUED`'s authority needs to name both the
  original payment (`razorpayPaymentId`, consistent with `DEPOSIT_CAPTURED`) and the refund itself —
  two distinct Razorpay records.
- **`PaymentRail` type** (`'manual_capture' | 'reserve_pay'`) introduced a slice early, since a stubbed
  `AUTHORIZATION_RELEASED` still has to name a rail honestly — the trail must never be silent about
  which rail (if any) was in play, even in a stub.
- Migration `0003_lean_gorgon.sql` — `ALTER TYPE event_type ADD VALUE` for both new event types, applied.

## Test coverage — the "Done when" acceptance criteria

1. **Integration test against Razorpay test mode, asserting the refund exists at Razorpay, not just our
   log.** `src/app/decline-booking.live.integration.test.ts`. See "What actually hit Razorpay" below for
   why this is a seeded-history test rather than a from-scratch `hold -> confirm -> decline` — the same
   Checkout-completion constraint dev-logs/006/007 already documented applies identically here.
2. **Full flow, all five events in order, in one transaction; cause=MERCHANT; ladder not applied.**
   `src/app/decline-booking.integration.test.ts`, against real Postgres + `FakePaymentProvider` +
   `FrozenClock` — fast and deterministic, covers everything the live test can't (full `hold -> confirm
   -> decline`, since `FakePaymentProvider`'s capture is synchronous).
3. **Decline 2 hours before the appointment (deep in the 100% tier) retains ₹0.** Same file, dedicated
   test — asserts full refund regardless of proximity, proving cause beats the ladder rather than merely
   asserting the ladder was skipped.
4. **A partial failure mid-sequence rolls back all events, not just the failing one.** Same file — a
   direct `tx.append()` call with a deliberately duplicated sequence number, asserting the whole
   transaction rejects and none of the batch lands. This exercises the exact `append()` the real
   five-event write uses, so it proves the atomicity that write depends on rather than asserting the
   mechanism exists.
5. **No agent-callable path can trigger a decline.** Structural (no MCP tool registered — the existing
   Slice 1 tool-list assertion in `mcp-e2e.integration.test.ts` already proves this by exact match) plus
   directly tested: `src/adapters/merchant-api/merchant-api.integration.test.ts` asserts a missing or
   wrong bearer token is rejected with `401` *before* the booking is touched (still `CONFIRMED`
   afterward), a schema-invalid body is rejected with `400` before reaching `declineBooking` at all, and
   the correct token completes the decline end to end (`200`, `refund.amountPaise > 0`, projection
   flips to `DECLINED_BY_MERCHANT`). Also covers `404` (unknown booking) and `409` (booking not yet
   `CONFIRMED`).

`npm test` (76 tests, `tsc --noEmit && vitest run`) passes clean, twice in a row (checked deliberately —
see the idempotency-cache bug below).

## What actually hit Razorpay, and what didn't

Same constraint dev-logs/006 and 007 already established for the deposit leg, now hitting the refund
leg's *setup*: a standard test account cannot complete a payment server-side, so `confirm_with_deposit`
against the real `RazorpayPaymentProvider` only finishes once a human completes Checkout — nobody is
present in an unattended test run. `decline_booking` itself needs an already-`CONFIRMED` booking to
decline, so a fully-live `hold -> confirm -> decline` was blocked at the same step Slice 2 already
documented, for the same reason.

Rather than repeat "the automated suite proves the logic, a human proved the full chain once, manually"
(dev-log 006's resolution), this slice found a way to keep the live test both automated *and* genuinely
live: `decline-booking.live.integration.test.ts` seeds a `CONFIRMED` booking's event history directly
(`HOLD_CREATED -> POLICY_ACKNOWLEDGED -> DEPOSIT_CAPTURED -> BOOKING_CONFIRMED`, the exact shape
`confirm_with_deposit` itself writes) pointing at `pay_TTFUhHVTQOyr0o` — the refund-idempotency fixture
dev-logs/006 already established and already refunded in full (verified live before writing this test:
`status: "refunded"`, `amount_refunded: 30000`, one refund `rfnd_TTFbG2lqrZOatR` on receipt
`latch-live-test-refund-key`). Calling `declineBooking` with that same idempotency key drives the real
`refundDeposit -> payments.fetchMultipleRefund` receipt lookup against Razorpay's live API and gets back
that same real refund id — genuinely proving "the refund exists at Razorpay," not a mock, without
needing a fresh human Checkout or mutating a payment further. None of the three existing fixtures could
take a *fresh* refund under a *new* key (the keeper must never be refunded; the header-discovery probe
and this fixture are both already refunded in full, and Razorpay rejects refunding an already-fully-
refunded payment) — reusing the known key against the known fixture was the only live option that
doesn't require a new checkout.

**Found and fixed a real bug while building this:** the first run of this test passed in isolation, then
failed when run as part of the full suite. Cause: `IdempotencyStore` keys are scoped to `(scope, key)`
only, not `bookingId`. This test deliberately reuses the same fixed key every run (it has to — see
above), but a fresh `bkg_livedecline_<ulid>` is minted per run. The *first* run stored a
`decline_booking` idempotency cache entry under that key; every run after that hit the cache and
returned the stale cached result — for a completely different `bookingId` — without ever touching the
new run's booking, which silently passed early assertions (the cached response's `.status` literal is
always `'DECLINED_BY_MERCHANT'` regardless of which booking generated it) and only failed on the final
`loadSnapshot` check, since that *new* booking had never actually been declined. Fixed by clearing the
`(decline_booking, latch-live-test-refund-key)` idempotency row in `beforeAll`, so each run genuinely
exercises `declineBooking` and the real Razorpay lookup rather than a local cache hit. Verified fixed by
running `npm test` twice in a row.

## Decisions made that the docs did not settle

- **Cause is embedded in the type, not passed as a value.** slice-3.md's language ("cancel takes cause
  as a required field") reads as one command with a cause parameter; this slice has no `cancel` command
  at all yet (Slice 5 scope) and only one caller of the decline path exists (the merchant API), so the
  strongest available guarantee is that `cause` cannot be anything but the literal `'MERCHANT'` at the
  only call site that exists. When Slice 5 adds `CANCELLED_BY_CUSTOMER`, it is a structurally distinct
  event type reached from a structurally distinct (agent-facing) command — not a shared event with a
  cause flag that could be set wrong.
- **`declineBooking` throws plain typed errors (`BookingNotFoundError`, `BookingNotDeclinableError`,
  `NoDepositFoundError`) rather than the `Refusal`/`ACTION_REFUSED` machinery.** `docs/03-domain-model.md`
  §5's refusal vocabulary is specifically for agent-facing gate/bound rejections recorded as trail
  events; an invalid merchant request (unknown booking, wrong state) is an administrative error on a
  trusted, authenticated surface, not an agent inference to record for B4's sake. Mapped to plain HTTP
  status codes (404/409/422) instead.
- **"Push the offer back to the originating agent" is satisfied by the returned response plus the
  `ALTERNATIVES_OFFERED` trail event, not a notification channel.** `docs/04-features-and-limitations.md`
  §2.1 already lists notifications as a deliberate non-goal, and Slice 6 (the SSE live trail) is the
  actual mechanism by which an agent or viewer picks this up asynchronously. This slice makes sure the
  structured data exists and is recorded; wiring an active push is later scope.
- **Fastify introduced now, scoped to one route.** Weighed against waiting for Slice 6/7 to introduce
  the HTTP server generally. slice-3.md names "Merchant API: decline_booking" with token auth as its
  first build item, which reads as wanting a real authenticated endpoint now, not a placeholder — so
  `src/adapters/merchant-api/` exists as its own small adapter, with `mark_no_show` and `set_policy`
  (also named in the architecture diagram) deliberately left unstubbed for the slices that own them.

## Docs updated

`docs/03-domain-model.md` §4: added the missing `SLOT_RELEASED` catalogue row, and a footnote clarifying
that `AUTHORIZATION_RELEASED` carries no ★ of its own because Slice 3 appends it as a stub (no real
authorisation exists yet to release) — Slice 4 fills in `authorizationId` without changing the event
type or the transaction shape. §6: added a paragraph under the worked trace stating plainly what Slice 3
alone actually produces (no `AUTHORIZATION_HELD` line yet — that's Slice 4 — so `BOOKING_CONFIRMED`
follows `DEPOSIT_CAPTURED` directly this slice) and pointing at the live test that verifies the five
decline-path lines against a real Razorpay refund.

## Carried forward

- **Slice 4** still owns: `AUTHORIZATION_HELD` (real ceiling, `enforced_by: payment_rail`), filling in
  `AUTHORIZATION_RELEASED.authorizationId` and dropping the stub `note`, the
  `MandateRegisteredEvent`/`MandateRevokedEvent` cleanup (still present and unused — dev-log 006 already
  flagged this as Slice 4's rename), and `BoundEnforcer`'s `razorpay_mandate` -> `payment_rail`
  generalisation.
- **Slice 6** owns actually pushing `ALTERNATIVES_OFFERED` to the originating agent (SSE), per the
  scoping decision above.
- **`decline_booking`'s HTTP route shape** (`POST /bookings/:bookingId/decline`) is a plain RESTful
  design, not literally named `decline_booking` in the URL the way the architecture diagram's box lists
  it. Worth a look when Slice 6/7 formalises the full merchant API surface (`mark_no_show`, `set_policy`)
  alongside it, for a consistent naming convention across all three routes.
- Everything in dev-log 006's carry-forward list not touched above is unchanged.
