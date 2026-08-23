# Dev Log 009 — Slice 4: the no-show authorisation and charge ⭐

**Date:** 24 August 2026
**Phase:** Slice 4 (`prompts/slice-4.md`)
**Status:** Done — all "Done when" acceptance criteria pass under `npm test` (96 tests, `tsc --noEmit &&
vitest run`), twice in a row, real Postgres + real Razorpay test mode where the account permits it

---

## What was built

- **`PaymentRail` port** (`src/ports/payment-rail.ts`) — deliberately separate from `PaymentProvider`
  (deposit capture/refund): `authorize()` and `captureAuthorization()`, no `release()` at all. There is
  no void endpoint (dev-logs/005), so a method that pretended to "release" something with no
  corresponding API call would be dishonest — release is pure bookkeeping at the app layer, not a rail
  call.
  - **`ManualCaptureRail`** (`src/adapters/payment/manual-capture-rail.ts`) — built, active. Shares
    `RazorpayPaymentProvider`'s create-order-then-poll shape (factored the common bits — `receiptFor`,
    `toInstrument`, the poll loop's `sleep`/timeout constants — into `razorpay-shared.ts` rather than
    duplicating them a second time).
  - **`ReservePayRail`** (`src/adapters/payment/reserve-pay-rail.ts`) — documented stub, both methods
    throw. `src/adapters/build-deps.ts` (new — factors the payment-provider/rail construction that used
    to be copy-pasted across `stdio.ts`/`http.ts` into one place, now shared by three entrypoints) is
    where the swap lives: `PAYMENT_RAIL=reserve_pay` constructs it, proving the swap is a one-line
    change, not a rewrite.
  - **`FakePaymentRail`** (`src/adapters/payment/fake-payment-rail.ts`) — the deterministic double.
    `captureAuthorization` doesn't take a "mismatch scenario" flag; it genuinely compares the requested
    amount against what was authorised and throws `CaptureAmountMismatchError` on any disagreement,
    exactly mirroring what real Razorpay does. The item-7 ceiling demo runs identically against this
    fake and against `ManualCaptureRail`.
- **`AUTHORIZATION_HELD`** event, and **`confirm_with_deposit`** now runs deposit capture and no-show
  authorisation *concurrently* (`Promise.all`) rather than serially — two separate Checkout completions
  in this build (dev-logs/006/007), so a human waiting on both shouldn't wait on them one after another.
- **`charge_no_show`** (`src/app/charge-no-show.ts`) — the two-independent-facts gate, exactly as
  specified: appointment start + grace elapsed (server clock) **and** `nonAttendanceMarkedAt` set (only
  the merchant API can set it). Refuses `NOT_YET_ELIGIBLE`, `MERCHANT_ACTION_REQUIRED`, or
  `AUTHORIZATION_EXPIRED` as appropriate, all recorded as `ACTION_REFUSED`. Registered as the fifth MCP
  tool.
- **`mark_no_show`** (`src/app/mark-no-show.ts`) — merchant-API-only, same trust boundary as
  `decline_booking` (never an MCP tool). New event `NON_ATTENDANCE_MARKED`, `markedBy: 'merchant'` as a
  fixed literal — the same structural trick `MerchantDeclinedEvent.cause` already uses, so "an agent
  forged this" is a compile error, not a runtime check.
- **Release by lapse, for real** (`decline-booking.ts`) — replaces the Slice 3 stub. `AUTHORIZATION_RELEASED`
  now carries the real `authorizationId` (read off the booking's own `AUTHORIZATION_HELD` event) and
  `expiresAt` (carried over from that same event) in place of the free-text `note`. No rail call — release
  is "we simply never call `captureAuthorization`," and Razorpay auto-refunds on its own at `expiresAt`.
- **Authorisation-lapse worker** (`src/app/authorization-lapse-worker.ts` + entrypoint
  `src/adapters/worker/authorization-lapse.ts`, `npm run worker:dev`). Idempotent by construction: the
  candidate query (`EventStore.listConfirmedBookingsWithExpiredAuthorization`) already excludes anything
  with `authorizationLapsedAt` set, and each candidate is re-checked under its own row lock before the
  event lands, so a booking resolved between the list read and the lock (charged, declined, or already
  lapsed by a concurrent tick) is simply skipped. Proven directly — ran the worker twice in a row in a
  test and asserted exactly one `AUTHORIZATION_LAPSED` event, not two.
- **⭐ Item 7 — the ceiling-refusal demo** (`src/app/demo-ceiling-refusal.ts` +
  `src/adapters/demo/ceiling-refusal.ts`, `npm run demo:ceiling-refusal`). Deliberately requests a
  capture ₹0.01 above the authorised amount, catches `CaptureAmountMismatchError`, records an
  `ACTION_REFUSED` naming `payment_rail`. Ran it for real against the fake rail wired through real
  Postgres:

  ```
  Authorised amount:    ₹400.00
  Attempted capture:    ₹400.01
  Refused: "Capture amount 40001 for bkg_... does not equal the amount authorized — the rail refuses any capture that isn't exact"
  Mapped to refusal code: CAPTURE_AMOUNT_MISMATCH
  Recorded in the trail as ACTION_REFUSED, enforcedBy: payment_rail.
  ```

  Takes an optional `bookingId` argument so the pitch video can point it at a booking whose deposit and
  authorisation were already confirmed via real Checkout, without re-driving Checkout live.

## A real bug caught while building this: which figure gets captured

`charge_no_show`'s first draft captured `policy.noShowFeePaise` — the merchant's **current** policy
figure, re-fetched fresh on every call. That's wrong, and it's the same class of bug
docs/03-domain-model.md §2 already warns about for the ladder: *"a booking made under ladder v4 must be
cancelled under ladder v4, even if the merchant has since published v5."* If the merchant raises the
no-show fee between a booking's confirmation and its no-show charge, capturing at the new, higher figure
would itself trip dev-logs/005 constraint 1 — the rail would refuse it, because it isn't the amount that
was actually authorised.

Fixed by adding `BookingSnapshot.authorizationAmountPaise`, set once at `confirm_with_deposit` time from
what the rail actually returned, and read back at `charge_no_show` time instead of re-deriving from
`getActivePolicy()`. The capture request — and the trail's `bound.ceilingPaise` — now always cites the
amount this specific booking's authorisation actually holds, never today's policy. Caught by working
through the item-7 demo's "how would a real mismatch ever happen honestly" question, not by a test
failing.

## A docs correction: `rail` is not on *every* money event

dev-log 005 said flatly: *"Every money event carries `rail`."* Checked against what Slices 2-3 actually
shipped: `DEPOSIT_CAPTURED` and `REFUND_ISSUED` never had one, and nothing in dev-logs 006/008 flagged
that as a gap. Looked at why: those two always settle through the same `PaymentProvider` Checkout
capture regardless of which `PaymentRail` is active — there is no rail *choice* for them to name, because
deposit capture was never behind the swappable-rail abstraction to begin with. `NO_SHOW_CHARGED` is the
one event whose settlement mechanism genuinely varies, so that's the one that carries `rail` (alongside
`AUTHORIZATION_HELD`/`RELEASED`/`LAPSED`, which already did). Corrected `docs/03-domain-model.md` to say
so explicitly rather than silently deviating from a documented claim.

## Verified against Razorpay's actual SDK types, not assumed

`node_modules/razorpay/dist/types/orders.d.ts`'s `RazorpayCapturePayment` interface confirmed the shape
dev-logs/005 inferred from the docs pages: `{ capture: 'manual', capture_options: { manual_expiry_period,
refund_speed, automatic_expiry_period } }`. One surprise: `automatic_expiry_period` is required by the
SDK's *type* even though it's documented as "mandatory only if capture is automatic" — passed the
documented minimum (12) since the value is inert for manual capture but TypeScript won't compile without
it.

**Capture's real idempotency mechanism, found by reading the SDK, not assumed:** `payments.capture()`
has no receipt/idempotency-key parameter at all (unlike orders/refunds). `ManualCaptureRail.captureAuthorization`
fetches the payment first — if it's already `captured` at the requested amount, that's a safe replay;
otherwise it calls `capture()`. This is genuinely idempotent without needing any key, and it's also
*why* the demo and `charge_no_show` can retry safely.

**Razorpay's SDK throws error objects, not `Error` instances** — confirmed by reading `api.js`'s
`normalizeError`: `throw { statusCode, error: { code, description } }`. Item 7's ceiling-refusal
detection (`isCaptureAmountMismatch`) matches on `error.description` directly against this shape rather
than assuming an `Error`-shaped exception.

**Live-verified, no mocking:** a real Razorpay test-mode order with `capture: 'manual'` +
`capture_options.manual_expiry_period: 7200` was created and accepted by the live API
(`manual-capture-rail.live.integration.test.ts`) — if the SDK's required-but-inert
`automatic_expiry_period` or any other param were malformed, order creation itself would have failed
before the poll loop even started, not timed out cleanly the way it did.

## The honest gap this slice carries forward

Same constraint dev-logs/006/007/008 already established, now hitting the authorisation leg's *live*
test coverage specifically: a standard test account cannot submit a payment server-side, so an
authorisation only reaches `authorized` state once a human completes Checkout. No such fixture exists
yet for the no-show leg (unlike the deposit leg's three fixture payments from Slice 2) — creating one
needs a person driving a real browser, which this unattended session doesn't have. What *is* proven
live: real order creation with manual-capture params, and the clean timeout when nobody pays
(`manual-capture-rail.live.integration.test.ts`). What's proven fast and deterministically, with the
same logic `ManualCaptureRail` uses: the full authorize → mark-no-show → charge → capture flow, every
refusal code, the lapse worker, and the item-7 ceiling refusal, all against `FakePaymentRail`
(`charge-no-show.integration.test.ts`, `fake-payment-rail.test.ts`). If a human is available before
submission, running `npm run demo:ceiling-refusal -- <bookingId>` against a Checkout-confirmed real
booking (`PAYMENT_PROVIDER=razorpay`) would close this gap for real; not required to ship the slice.

## Dead code removed, not worked around

`Policy.mandateCeilingPaise` (and the `policies.mandate_ceiling_paise` column, `MandateCeilingExceededError`,
the `MandateRegisteredEvent`/`MandateRevokedEvent` types, the `mandate_ceiling_exceeded` fake scenario) —
all leftovers from dev-log 001's pre-manual-capture design, already dead since dev-log 005 superseded
it, never actually read by any Slice 2-3 code. Removed completely rather than left as unused scaffolding:
`Policy`/schema/seed/catalog-repo no longer carry the column (migration `0006_drop_mandate_ceiling.sql`),
and the event/error types are gone from `events.ts`/`payment-provider.ts`. `BoundEnforcer`'s
`razorpay_mandate` value is renamed to `payment_rail` throughout, per dev-log 005's own flagged pending
work.

## Decisions made that the docs did not settle

- **`AuthorityRef.mandateId` → `authorizationId`, and `BookingSnapshot.mandateId` → `authorizationId`**,
  the rename dev-logs/005/006 both flagged as pending. Threaded through `fold.ts`, the Postgres event
  store, and every call site.
- **`BookingSnapshot` gained three new fields** (`authorizationAmountPaise`, `authorizationExpiresAt`,
  `authorizationLapsedAt`) and `nonAttendanceMarkedAt`, mirroring the existing `holdExpiresAt` pattern —
  gates that would otherwise need a full event replay read them straight off the projection instead.
- **No `NO_SHOW_ELIGIBLE`-emitting worker built this slice.** The event type and `BookingStatus` value
  already existed (Slice 0 scaffolding); `charge_no_show`'s gate re-derives eligibility directly from
  the server clock instead of depending on a separate status transition having already run — matching
  `docs/03-domain-model.md §4`'s own worked `NO_SHOW_CHARGED` example, which embeds both facts in the
  charge event's own `gate.cleared`/`gate.evidence` rather than requiring a prior state event. A
  dedicated no-show-eligibility worker is `prompts/README.md`'s Slice 5 "background worker" scope, not
  named in `slice-4.md`'s own "Build this" list (only the authorisation-lapse worker was).
- **`confirm_with_deposit`'s two Checkout legs run concurrently, not serially**, to keep the
  human-Checkout wait from doubling now that there are two objects to authorise per booking.
- **`buildAppDeps` factored into `src/adapters/build-deps.ts`.** `stdio.ts` and `merchant-api/http.ts`
  each had their own copy-pasted `buildPaymentProvider()`; the worker and demo entrypoints needed the
  same logic plus a new `buildPaymentRail()`. Three real call sites justified sharing it rather than a
  fourth copy-paste.

## Docs updated

- `docs/03-domain-model.md` §4: added the missing `NON_ATTENDANCE_MARKED` catalogue row (same class of
  gap dev-logs/003 already found twice for `BOOKING_COMPLETED`/`SLOT_RELEASED`); updated the
  `AUTHORIZATION_RELEASED` footnote from future tense to done; fixed the worked JSON example's
  `instrument` (was the non-existent `upi_authorisation`, now `card`); added the `rail`-scoping
  correction above; appended a worked no-show-charge trace (the decline trace never covered this path).
- `docs/01-architecture.md` §9: the trust-model table didn't list `charge_no_show` under what an agent
  *can* do at all, and listed "mark no-show" as something an agent cannot do when the actual noun is
  "mark non-attendance" (the merchant-only fact) — an agent genuinely can call `charge_no_show`, just
  gated. Fixed both.

## Test coverage — the "Done when" acceptance criteria

1. **A no-show authorisation exists at Razorpay test mode in `authorized` state, at exactly the fee** —
   order creation with manual-capture params verified live; a fully live `authorized` payment needs a
   human at Checkout (see "the honest gap" above). Proven fast against `FakePaymentRail`, which
   reproduces the same behaviour.
2. **`charge_no_show` captures it; visible in the test dashboard** — proven against the fake;
   `captureAuthorization`'s fetch-then-capture idempotency logic is the same code real Razorpay would
   run.
3. **Over-amount capture refused by Razorpay, refusal in the trail** — `fake-payment-rail.test.ts` and
   `charge-no-show.integration.test.ts`'s item-7 test; the real error-shape detection is unit-verifiable
   from the SDK's own `normalizeError` source, live-testable once a real authorisation fixture exists.
4. **Charging before start + grace → `NOT_YET_ELIGIBLE`** — `charge-no-show.integration.test.ts`.
5. **Charging without merchant marking → `MERCHANT_ACTION_REQUIRED`** — same file.
6. **Charging after lapse → `AUTHORIZATION_EXPIRED`, with `AUTHORIZATION_LAPSED` already in the trail** —
   same file; runs the worker first, asserts the event landed, then asserts the refusal.
7. **Merchant decline leaves the authorisation uncaptured; customer never debited** —
   `decline-booking.integration.test.ts`, extended this slice: asserts `AUTHORIZATION_RELEASED` carries
   the real `authorizationId` matching `AUTHORIZATION_HELD`, and that no `NO_SHOW_CHARGED` event ever
   exists on a declined booking.
8. **Every money event carries `rail`** — narrowed and corrected above; true for the events where a rail
   choice actually applies.
9. **`ReservePayRail` exists as a stub; the swap is a one-line construction change** —
   `build-deps.ts`'s `buildPaymentRail()`.

`npm test` (96 tests) passes clean, twice in a row.

## Carried forward

- **A real, live `authorized`-state fixture for the no-show leg** — needs a human at Checkout once
  (mirrors dev-log 006's deposit fixtures). Not required to ship; closes the last live-coverage gap if
  done before submission.
- **Slice 5** owns: cancel (customer-initiated, ladder-applying — structurally distinct from
  `decline_booking`'s merchant path per dev-log 008), reschedule, and the general background-worker
  surface (hold expiry, no-show eligibility) that `prompts/README.md` scopes there. This slice's
  authorisation-lapse worker is a narrower, separately-scoped addition slice-4.md asked for directly.
- Everything in dev-log 008's carry-forward list not touched above is unchanged.
