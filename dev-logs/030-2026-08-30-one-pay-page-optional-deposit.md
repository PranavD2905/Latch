# Dev Log 030 — One pay page, only the legs that apply, and the conversation that drives it

**Date:** 30 August 2026
**Trigger:** Direct user follow-up after seeing dev-logs/029's `PENDING` result run live. Four asks, in
their words: *"should have the option to pay and auth for both on the same page"*; *"if the merchant has
set 0 no show fee, it should show only the deposit and session complete options or maybe no deposit is
set, it should not show the deposit link"*; `get_booking` should say what's missing in plain language;
and the agent should *"give the link, ask you to give a heads up once you paid… it only polls when the
user prompts that it is paid."*

Builds directly on dev-logs/029 — nothing there was undone.

---

## 1. One `payUrl`, not one per leg

`ConfirmWithDepositResult`'s `PENDING` branch went from `pendingPayments: [{leg, label, amountPaise,
payUrl}]` to a single `payUrl` plus `outstanding: [{leg, label, amountPaise}]`. The route collapsed from
`GET /pay/:bookingId/:leg` to `GET /pay/:bookingId`, and that one page now renders a row per applicable
leg with its own Pay button.

Razorpay Checkout still takes exactly one `order_id` per invocation, so this remains up to three
sequential Checkout invocations — but from one page, one link, and the page shows per-leg status so
partial completion is visible and resumable by reloading. Each row's button opens Checkout against that
row's own order; verified live in a real browser that the middle (₹400 no-show) button opens Checkout
showing ₹400, not the deposit's ₹300.

**A done leg renders as a fact, not a button.** The page reads live per-leg status from Razorpay on each
load (the same `pending-payment-status.ts` primitive `get_booking` uses) rather than from our own trail,
because the trail deliberately doesn't record *any* leg as landed until *every* applicable leg has —
they're written in one atomic finalize transaction. So a leg can genuinely be paid as far as Razorpay is
concerned while the trail still says nothing, and only asking Razorpay directly gets that right. A leg
that comes back done renders with a ✓ and no button and its `order_id` never reaches a Checkout
invocation on that page at all — which is what makes "reloading the page can't re-pay a completed leg"
structural rather than a guard someone has to remember.

## 2. Only the legs that actually apply

Deposit is now optional, matching the discipline the no-show fee already had:

- `Policy.depositAmountPaise` / `PolicyDraft` / `PolicyInput`: `Paise | undefined`.
- `validatePolicyInput`: positive integer *when set*; absent is fine. **An explicit `0` is still
  rejected** — deliberately. Absent is the only way to say "no deposit," which is exactly what makes a
  ₹0 Razorpay order structurally impossible rather than merely avoided: `confirm_with_deposit` branches
  on `!== undefined` and never constructs the order at all. A `0` would have had to be defended against
  at every downstream call site instead.
- Migration `0016_optional_deposit.sql`: `ALTER COLUMN deposit_amount_paise DROP NOT NULL`.
- `POST /policy`'s wire schema drops `depositAmountPaise` from `required`.

`confirm_with_deposit` now computes `needsDeposit` / `needsNoShowAuth` / `needsSessionCompleteAuth` and
creates orders, polls, appends events, and offers links for exactly that set. A merchant with no deposit
and no no-show fee gets a single-leg page: the session-complete hold for the full service price (since
the mandate is `price - (deposit ?? 0)`). `ConfirmWithDepositResult`'s `deposit` field became optional to
match, and no `DEPOSIT_CAPTURED` event is written when there's no deposit leg — verified by test that the
trail contains no ₹0 money event in that configuration.

**The number of legs is a policy consequence, not a code constraint** — worth stating plainly because it's
also the demo lever: if three Checkouts feels heavy on camera, that's a policy decision the user can make
without touching code.

## 3. `get_booking` reports what's missing, in plain language

New `GetBookingResult.pendingPayment: { payUrl, outstanding[], completed[] } | undefined`. Each entry
carries the same human label the pay page and `confirm_with_deposit` use — *"₹400 no-show hold — only
charged if you miss your appointment"* — never a bare `no_show_authorization`. Status is checked live per
leg, for the same reason the pay page does it (see above). `undefined` when nothing is pending.

Read-only and non-throwing throughout: a rail hiccup while checking status reports `done: false` rather
than failing the call, since the conservative default (never claim something is paid when we couldn't
confirm it) is the only safe one for a tool whose entire job is telling an agent the truth about state.
The user's worked example — deposit paid, session-complete authorisation missing — is pinned as a test.

## 4. The conversation shape, which lives entirely in the tool descriptions

This is the part that isn't really code. The MCP tool descriptions *are* the prompt; a model reading them
follows them literally, and `confirm_with_deposit`'s still said it *"blocks on a real customer completing
payment checkout and can legitimately take minutes"* — stale since dev-logs/029 and actively harmful, since
it would push a model toward waiting instead of handing over the link.

Rewritten so the intended conversation falls out of the description alone, with no client-side logic:

- On `PENDING`: give the user the single `payUrl` as a link, describe what it covers using each
  `outstanding` label (they already read as sentences), never surface field names or raw JSON, then
  **stop and ask the user to say when they've paid**.
- **Explicitly: do not poll on a timer, do not retry speculatively.** Only re-check when the user says
  they've paid or asks.
- On re-checking: if still `PENDING`, name the legs still left in plain language (*"the deposit went
  through, but the no-show hold hasn't been authorised yet"*) and ask again.
- `get_booking`'s description got the matching half, plus one thing worth being explicit about: it never
  finishes a booking. If `outstanding` is empty there, the agent must still call `confirm_with_deposit` —
  otherwise a model could plausibly read "nothing outstanding" as "confirmed" and tell the user a booking
  is done when the trail has no `BOOKING_CONFIRMED` for it.
- The dev-logs/012 timeout guidance (call `get_booking` first, never retry with a fresh idempotency key)
  is preserved verbatim — still correct, still load-bearing.

## A behavioural change worth calling out, because it wasn't asked for directly

Before this, an optional leg whose order existed but simply hadn't been paid yet would let the booking
confirm anyway. That was invisible before dev-logs/029 (the old blocking `authorize()` either returned a
result or threw), but once polling can cleanly return "nothing yet, no error," it became reachable and
wrong: the user's own example — *deposit paid, session-complete authorisation missing* — has to keep the
booking waiting, not confirm without the mandate.

So: an applicable leg that is merely unpaid now keeps the result `PENDING`. A leg that genuinely *errors*
is still forgiven exactly as dev-logs/028 established — confirm proceeds without it rather than waiting on
an outage forever, which is what protects an already-captured deposit from being stranded by an unrelated
leg's fault. The deposit leg keeps its own exception throughout: a real decline or rail fault on the
deposit rejects immediately, since there's nothing captured yet to protect by waiting.

**I got this wrong once mid-implementation** and made *every* leg's failure block confirmation, including
order-creation failures. `chaos-payment-outage.integration.test.ts` caught it immediately — that test
exists precisely to pin dev-logs/028's stranded-deposit fix, and it failed loudly rather than letting a
regression through. Corrected to the split above: order-creation failure on an optional leg is forgiven
(there's no orderId, so there's nothing to link to or check anyway); only the deposit's is fatal.

## Did allowing a zero deposit surface anything unexpected downstream?

Asked directly, so answered directly: **almost nothing, and that's the interesting part.** The changes were
confined to the type, the validator, one migration, the repo mapping, and the leg-selection branch in
`confirm_with_deposit`. Nothing in the ladder, refund, retention, reconciliation, or no-show paths needed
touching.

Two small things did surface:

1. **`SERVICE_PRICE_BELOW_DEPOSIT` needed a `?? 0`** to keep comparing against a real number. Harmless,
   but it's the one gate that reads the deposit amount directly.
2. **~10 test call sites needed `confirmed.deposit!`** now that the result field is optional. Mechanical,
   but it's honest signal about how much of the suite assumes a deposit exists — every one of those tests
   runs against the seed policy, which still has one. The no-deposit configuration is covered by new
   dedicated tests rather than by widening the existing ones, which would have made them less specific.

The reason the blast radius was small is that the deposit amount was already only read in two places that
matter (the gate's price check and the confirm's leg construction) — everything downstream reads the
*frozen* per-booking amounts off the booking's own snapshot/events, never back off the policy. That's the
"money rules don't change retroactively" discipline from docs/03-domain-model.md §2 paying off in a way it
wasn't specifically designed for.

## Tests

`npm test`: 40 files, **281 tests**, all green (was 39 / 263).

New: `pay-page.test.ts` (7 — 1/2/3-leg rendering, done-renders-as-fact, no button once everything's done,
HTML escaping, the no-publishable-key path); 6 more in `confirm-with-deposit.fast.test.ts` (one `payUrl`,
no-deposit policy, no-deposit-and-no-no-show single leg, no `DEPOSIT_CAPTURED` for a no-deposit booking,
unpaid-optional-leg keeps it `PENDING`, and the full PENDING → pay → retry → CONFIRMED cycle asserting no
duplicate money events and that `pendingPaymentLegs` is cleared on confirm); 2 in
`policy-validation.test.ts` (absent deposit, absent deposit + absent no-show); 2 in
`get-booking.integration.test.ts` (no `pendingPayment` when nothing pending; the user's outstanding-vs-completed
example, asserting labels contain `₹` and no underscores); 1 in `merchant-api.integration.test.ts`
(`POST /policy` with `depositAmountPaise` omitted entirely).

One test-ordering note: the new merchant-api policy test had to go at the *end* of its `describe`. That
block's tests share sequential state and assert on specific policy version numbers, so publishing a policy
from the middle shifted every later version and broke three assertions. Moved rather than papered over.

## Verified live

Against real Razorpay test mode and a real browser, on a fresh booking:
- One `payUrl` returned; `get_booking` reported all three legs outstanding, zero completed, booking `HELD`.
- The page rendered all three legs with correct labels and amounts on one page.
- The no-show row's Pay button opened real Razorpay Checkout, Test Mode, showing **₹400** — per-leg order
  wiring correct, not just per-page.

Still not completable by this session, unchanged from dev-logs/029: actually finishing a Checkout payment.
Razorpay's bot-resistance blocks automated input into the card fields even in a real, non-headless browser.
The done-leg-renders-as-done path is therefore covered by unit test rather than live observation — the only
piece of this feature in that position.

## Carried forward

1. **A human still has to complete a real Checkout** to see a leg flip to done live, and to prove all three
   legs end to end (deposit captured, both authorisations left `authorized`). Everything up to that click is
   proven live.
2. **The user's MCP server is still running pre-restructure code** — it needs a restart against this build
   before any of this is drivable from Claude. Flagged by the architecture session; repeating it here
   because it's the difference between this working and appearing not to.
3. **The no-deposit path has not been driven against live Razorpay**, only against the fakes and the real
   wire schema. It creates strictly *fewer* orders than the covered path, so the risk is low, but it is not
   the same as having watched it.
