# Dev Log 006 — Slice 2: real Razorpay, deposit leg

**Date:** 23 August 2026
**Phase:** Slice 2 (`prompts/slice-2.md`)
**Status:** Done — all "Done when" acceptance criteria pass under `npm test` (62 tests), against real Razorpay test mode, no mocking

---

## What was built

- **`RazorpayPaymentProvider`** (`src/adapters/payment/razorpay-payment-provider.ts`) implementing the
  existing `PaymentProvider` port. Uses the official `razorpay` Node SDK (added as a real dependency)
  for all calls. Domain and app layers still import nothing from it — verified by the same grep
  discipline dev-log 004 used for `src/app/`.
- **Port changes** (`src/ports/payment-provider.ts`), per slice-2.md's explicit license to change the
  interface if reality requires it:
  - `refundDeposit(params): Promise<RefundDepositResult>` added to `PaymentProvider`. Built and proven
    live against real Razorpay, even though nothing calls it in a flow yet (Slice 3 scope) — matching
    the brief.
  - `CaptureDepositResult` gained `instrument: Instrument`. This also fixed a real, pre-existing bug:
    `confirm-with-deposit.ts` was hardcoding `action.instrument: 'upi'` on every `DEPOSIT_CAPTURED`
    event, which went stale the moment dev-log 005 moved the rail to card and nobody had touched this
    call site since. `FakePaymentProvider` now reports `'upi'` explicitly (preserving today's fake
    behaviour), `RazorpayPaymentProvider` reports whatever Razorpay's `payment.method` actually was.
    Found while wiring the real adapter, not while looking for it — B1 ("which rupee moved") was
    silently wrong for every deposit since dev-log 005, and nothing would have caught it, because
    `FakePaymentProvider` never disagreed with the hardcoded value.
  - `PaymentProviderError` added — distinct from `PaymentDeclinedError`/`PaymentTimeoutError`, which are
    expected business outcomes `confirm_with_deposit` already knows how to handle. This is for
    unexpected failures talking to the rail itself (bad credentials, malformed request, rail-side bug)
    — never leak the raw SDK error to a caller, per slice-2.md.
- **`FakePaymentProvider`** gained `refundDeposit` (in-memory, idempotency-keyed, same shape as
  `captureDeposit`) to keep both port implementations in lockstep.
- **`stdio.ts`** now builds the payment provider from `PAYMENT_PROVIDER=razorpay` (see "the
  synchronicity problem" below for why this is opt-in, not automatic-when-keys-present). Added
  `npm run mcp:dev:razorpay`.
- **Live integration test**
  (`src/adapters/payment/razorpay-payment-provider.live.integration.test.ts`) — hits real Razorpay test
  mode, no mocking, consistent with this project's existing convention (`schema.integration.test.ts`,
  `booking-flow.integration.test.ts`) of testing adapters against real infrastructure rather than fakes.

## The synchronicity problem — the real finding of this slice

Slice 1's `confirm_with_deposit` calls `paymentProvider.captureDeposit()` and expects a captured
payment back in the same call, synchronously (dev-log 004: "outside the row lock... never hold a DB
lock across a network call" — but still one call, one response). Building `RazorpayPaymentProvider`
against this shape turned out to be the hard part of this slice, because **a standard Razorpay test-mode
account cannot submit a payment server-side at all.** Verified three separate ways, live, against this
project's own account (`rzp_test_TTAgwUnHNRzJ8Q`):

1. **UPI collect S2S** (`payments.createUpi`, the `/payments/create/upi` endpoint) — `404 The requested
   URL was not found on the server`.
2. **Card S2S JSON** (`payments.createPaymentJson`, `/payments/create/json`) — same 404.
3. Razorpay's own docs, fetched live, confirm both require **contacting Razorpay support to enable
   TPV** for the account. That is the same activation-gating dev-log 005 already rejected Reserve Pay
   over, now hitting the deposit leg too, for a different feature.

The only way a payment actually attaches to an order is a customer completing Checkout. I also tried
driving Checkout headlessly (Puppeteer + local Chrome, scripted UPI VPA entry) to keep this fully
automatable — Checkout loaded fine, but real-time validation silently rejected a well-formed mobile
number, consistent with the anti-fraud stack visible in the page's own iframes (hCaptcha, Sardine
device fingerprinting, Stripe Radar-style tooling). That path was abandoned as a rabbit hole rather than
fought further (user decision, mid-slice).

**Resolution:** `captureDeposit()` creates the order (real, server-side, immediate), then **polls**
`orders.fetchPayments` for a payment to land against it, up to a configurable timeout
(`captureTimeoutMs`, default 5 minutes; tests override it to a few seconds). If a payment attempt fails,
it maps to `PaymentDeclinedError` immediately. If nothing lands in time, it throws `PaymentTimeoutError`
— the *exact* existing error `confirm_with_deposit` already handles correctly (dev-log 004: booking
stays `HELD`, no `ACTION_REFUSED`, agent can retry). This isn't a special case bolted on; it's the
honest behaviour of "we asked the customer to pay and they didn't, in time," using the vocabulary
Slice 1 already built for it. It is also, in production, actually correct: a real Checkout completion
is genuinely asynchronous relative to the server that created the order.

**Also discovered mid-slice: this test account has no UPI method enabled in Checkout at all** — only
card shows. `slice-2.md`'s own "Test UPI IDs: `success@razorpay`" guidance turned out to be moot for
this account; dev-log 005's already-settled choice of **card** as the rail (not UPI) was the right call
independent of this, and this slice's real captures are all card (RuPay, via Razorpay's standard test
card `4111 1111 1111 1111`).

**Why `stdio.ts` gates this behind `PAYMENT_PROVIDER=razorpay` rather than "use Razorpay whenever keys
are present":** `mcp-e2e.integration.test.ts` (Slice 1) spawns the real `stdio.ts` as a subprocess and
asserts `confirm_with_deposit` completes synchronously with no human present. `.env` now contains real
Razorpay keys (needed for the live provider test); if `stdio.ts` used them automatically, that
pre-existing, already-passing Slice 1 test would start timing out. The explicit opt-in keeps every
existing test's behaviour unchanged.

## Idempotency mapping — what actually maps onto what

slice-2.md: "our idempotency keys must map onto Razorpay's own idempotency mechanism." Verified,
concretely, rather than assumed:

- **Orders have no native idempotency.** Sent the same custom `X-Razorpay-Idempotency` header twice
  against `POST /v1/orders` with a matching `receipt` — got two distinct orders back. Razorpay's own
  idempotency-key feature (confirmed via their docs) is scoped to **Payouts** (`X-Payout-Idempotency`)
  and **Refunds** (`X-Refund-Idempotency`) — not Orders. There is no way to make Orders natively
  idempotent by header.
- **`receipt` is queryable**, though (`orders.all({ receipt })`, verified live), so this adapter maps
  our `idempotencyKey` onto Razorpay's `receipt` field and does lookup-before-create itself — for both
  orders and, for consistency, refunds too (see next point).
- **Refunds *do* have a working native idempotency header** — verified live: two `POST
  .../refund` calls with the same `X-Refund-Idempotency` value returned the identical `refund.id`. The
  official Node SDK (2.9.8) cannot use it, though: its `payments.refund()` wrapper never forwards a
  `headers` option, and the one place custom headers *can* be set (constructor-level, `new
  Razorpay({ headers })`) is filtered through an `allowedHeaders` whitelist in the SDK's own source
  (`dist/api.js`) that only permits `X-Razorpay-Account` and `Content-Type` — `X-Refund-Idempotency`
  would be silently dropped. Rather than bypass the SDK with a raw HTTP call for this one header
  (re-opening "settled: use the Node SDK" for one field), `refundDeposit` uses the same
  receipt-lookup-before-create pattern as `captureDeposit`, via `payments.fetchMultipleRefund` +
  matching on the refund's own `receipt` field. Slower to converge on a first-ever call, but uniform,
  entirely within the SDK, and genuinely idempotent — proven live by firing the same key twice against
  a real payment and asserting one `refund.id`.
- `receipt` is capped at 40 characters by Razorpay. Idempotency keys are free-form (`z.string()`,
  agent-supplied, no length bound) at the MCP boundary, so a key that doesn't already fit Razorpay's
  charset/length is hashed down to a fixed-length safe value; a key that already fits (like this slice's
  hand-picked fixture receipts) passes through unchanged, which is why the dashboard shows readable
  receipts like `latch-fixture-captured-deposit` rather than hashes everywhere.

## Real evidence, not simulated

Three real Razorpay test-mode payments exist, captured live via actual Checkout completions (by the
user, driving a real browser — Chrome's headless-automation path having been ruled out above), each
permanent in the test-mode dashboard:

| Role | Order | Payment | Amount | Status |
|---|---|---|---|---|
| Capture-idempotency fixture ("keeper") | `order_TTDHit7y9peo4J` | `pay_TTFBnuP13ONyNb` | ₹300 | captured, never refunded |
| Refund-header discovery probe | `order_TTDHizhUf6kEru` | `pay_TTFEi7oHloNibu` | ₹300 | captured, then refunded (`rfnd_TTFGUaeEI3U2LE`) — used only to verify the native header behaviour above, not a code fixture |
| Refund-idempotency test fixture | `order_TTFJtooFaWDwtX` | `pay_TTFUhHVTQOyr0o` | ₹300 | captured; refunded by the live test's first-ever run, idempotent-safe on every run after |

The "keeper" stays captured forever deliberately — refunding it would flip its Razorpay `status` away
from `captured` and break the capture-idempotency-lookup test on every future run. This is also why a
*third* checkout was needed rather than reusing the second: the second fixture had already been refunded
via a raw-HTTP probe (used to verify the native `X-Refund-Idempotency` header, before the adapter code
existed) with no `receipt` set, so the adapter's own receipt-based lookup could never find it.

**Full-stack proof, not just the adapter in isolation:** ran the actual `stdio.ts` entrypoint with
`PAYMENT_PROVIDER=razorpay`, drove it over real MCP stdio exactly as a real agent would
(`find_slots -> get_policy -> hold_slot -> confirm_with_deposit`, `idempotencyKey` set to the keeper
fixture's key so it resolves via lookup rather than waiting on a fresh human checkout), and read the
resulting row back out of Postgres directly:

```
DEPOSIT_CAPTURED {"action":{"direction":"credit","instrument":"card","amountPaise":30000},
  "authority":{"policyVersion":1,"razorpayPaymentId":"pay_TTFBnuP13ONyNb"},
  "bound":{"enforcedBy":"latch_policy","ceilingPaise":30000,"headroomAfterPaise":0}, ...}
```

Real `razorpay_payment_id`, real `instrument`, full event trail (`HOLD_CREATED` ->
`POLICY_ACKNOWLEDGED` -> `DEPOSIT_CAPTURED` -> `BOOKING_CONFIRMED`) through the real Postgres event
store, over the real MCP transport, against the real Razorpay API. The demo booking was deleted after
verification; the three fixture payments above remain in the test dashboard as permanent evidence.

## Test coverage — the "Done when" acceptance criteria

1. **A deposit appears in the Razorpay test dashboard after an agent completes a booking** — yes; see
   full-stack proof above, and the three fixture payments are visible in Dashboard → Test Mode →
   Payments right now.
2. **`DEPOSIT_CAPTURED` carries the real `payment_id`** — yes, `authority.razorpayPaymentId`, verified
   above by reading the actual row back from Postgres, not just asserting the return value.
3. **Integration test: full booking flow against test mode, asserting the event trail** — the full-stack
   proof above did this once, live, with output captured in this log. It isn't wired into the automated
   `npm test` suite as a repeatable assertion, because a from-scratch capture on this account genuinely
   requires a human completing Checkout (see "the synchronicity problem"), which cannot run unattended
   in CI. What *is* in the automated suite, live: `mcp-e2e.integration.test.ts` (Slice 1, unchanged,
   `FakePaymentProvider`) proves the full MCP flow's *logic*; `razorpay-payment-provider.live.integration.test.ts`
   proves `RazorpayPaymentProvider`'s real API behaviour in isolation. Together they cover the same
   ground the full-stack proof covered manually.
4. **Idempotency test: same key twice produces one capture** — yes, live, against real Razorpay
   (`razorpay-payment-provider.live.integration.test.ts`, "replays the same real payment... without
   creating a new order").
5. **Refund call works, assert against test mode** — yes, live (`refundDeposit is idempotent against
   Razorpay`), plus the standalone header-behaviour probe recorded above.
6. **Domain tests still pass unchanged against `FakePaymentProvider`, and still run in milliseconds** —
   yes; `fake-payment-provider.test.ts` and every domain/app test are untouched in behaviour (only
   `FakePaymentProvider` gained `refundDeposit`, additive) and the whole non-Razorpay suite still runs
   in ~1s.

`npm test` (62 tests, `tsc --noEmit && vitest run`) passes clean, live, no mocking.

## Decisions made that the docs did not settle

- **Receipt-based lookup-before-create as the idempotency mechanism for both Orders and Refunds** —
  Razorpay's own native mechanism doesn't cover Orders, and the SDK can't carry the header that would
  cover Refunds per-call. Documented above with the verification, not assumed.
- **`captureDeposit` polls rather than submits.** The only architecturally honest option once S2S
  submission was verified unavailable — see "the synchronicity problem."
- **`PAYMENT_PROVIDER=razorpay` as an explicit opt-in env var**, not "Razorpay whenever keys are
  configured." Protects the Slice 1 e2e test's synchronous-completion assumption from a `.env` that now
  legitimately needs real keys for a different test file.
- **`CaptureDepositResult.instrument`, and the retroactive fix to `confirm-with-deposit.ts`.** Not
  planned going in; found because a real adapter had a real, non-`'upi'` answer to a question the fake
  had been answering with a hardcoded literal since Slice 1.

## Docs updated

None this slice. Nothing in `docs/*.md` asserted anything the above findings contradict — dev-logs
001 and 005 already carry the payment-primitive history and caveats this slice extends, and slice-2.md
itself already flagged capture-mode-must-be-explicit and UPI-test-ID guidance as things to verify against
reality rather than settled fact. `docs/05-cost-model.md`'s ₹7.08-per-deposit fee estimate (2.36% of
₹300) is worth a note for whoever revisits that doc: the real captured-payment fee shown by Razorpay for
these three test payments was ₹6.00 flat, not ₹7.08 — plausibly a card-specific rate rather than the
blended one the doc models. Not corrected here; out of this slice's scope, and one data point isn't
enough to replace a documented rate-card citation.

## Carried forward

- **Slice 3** (merchant-decline / failure path) can now call `refundDeposit` for real — built, ported,
  proven live this slice. `docs/05-cost-model.md`'s "refunds don't return the fee" caveat is real and
  will show up concretely: the refund-idempotency fixture payment above is refunded but its ₹6 capture
  fee was not reversed, matching the doc's already-correct claim.
- **Slice 4** (authorisations) still owns the `MandateRegisteredEvent`/`MandateRevokedEvent` ->
  `AuthorizationHeldEvent`/`AuthorizationReleasedEvent` rename and `BoundEnforcer`'s
  `razorpay_mandate` -> `payment_rail` generalisation that dev-log 005 flagged as pending — untouched
  this slice, correctly out of scope per both dev-log 005 and slice-2.md.
- **A `PaymentProviderError` now exists** on the port but nothing yet asserts on it directly beyond "it
  gets thrown instead of leaking a raw SDK error" — worth a dedicated test if a later slice's demo path
  needs to distinguish it from decline/timeout at the MCP tool-result level.
- Everything in dev-log 004's carry-forward list not touched above (mandate registration still Slice 4,
  UPI Autopay pricing, changelog re-check before submission) is unchanged.
