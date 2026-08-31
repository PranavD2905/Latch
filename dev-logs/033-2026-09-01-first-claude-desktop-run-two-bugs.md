# Dev Log 033 — The first Claude-Desktop-driven booking, and two bugs it found

**Date:** 1 September 2026
**Phase:** First end-to-end run of the new UPI S2S pay flow (dev-logs entries for that slice), driven by
a real third-party agent connection rather than a script
**Status:** Both bugs fixed, tested, deployed. `npm test`: 282/282 green.

---

## Why this entry exists

The UPI S2S work closed the "a human must complete Checkout.js" caveat every dev log since 006 carried —
but everything proving it worked so far was either a scripted MCP client or a curl loop against the pay
page, not a real agent driven by a real person clicking through a real UI. The user connected Claude
Desktop to the deployed MCP endpoint and ran the actual flow: find a slot, hold it, confirm with deposit,
pay through the page. Two things went wrong that no test had caught, because both were about behaviour
*outside* the happy path the new feature's own tests were written against.

---

## Bug 1 — a lapsed hold still looked payable

### Symptom

Not observed directly this session, but found while investigating the pay page's guarantees after the
user's report below — a hold that had expired still rendered a live Pay form, and `get_booking` still
told the calling agent money was owed, on a slot that had already gone back to inventory.

### Root cause

`hold-expiry-worker.ts` flips a reclaimed booking's `status` to `EXPIRED` but was never clearing
`pendingPaymentLegs`. Every other path that moves a booking out of `HELD` already clears that field —
`confirm_with_deposit`'s own finalize, and `hold_slot` on a fresh booking. `cancel`/`decline` never touch
it because both require `status === 'CONFIRMED'` as a precondition, by which point it's already gone.
Hold-expiry was the one path that could leave a booking `EXPIRED` with `pendingPaymentLegs` still
populated.

`finalize-from-webhook.ts` already refuses to resurrect anything not still `HELD`, so a payment landing
this way was never going to confirm the booking — it would sit captured at Razorpay against nothing,
for reconciliation to eventually notice. Worth closing before it happens, not just detecting after.

### Fix

Two parts, because one alone left a gap:

- `hold-expiry-worker.ts` now clears `pendingPaymentLegs` in the same projection that flips `status` —
  fixes the common case, and fixes `get_booking` too, not just the pay page.
- That fix only takes effect once the worker's next tick actually runs. Between a hold really lapsing
  (by the server clock) and that tick, `status` is still `HELD` in the DB. `server.ts`'s pay routes now
  also compare `holdExpiresAt` directly against `now` — the identical test `confirm-with-deposit.ts`'s
  own gate transaction already uses — before rendering the page or touching the payment provider/rail.

A new fast test file (`server.pay-routes.test.ts`) proves the guard directly, including that a
lapsed-hold POST never reaches the payment provider at all. A hold-expiry-worker integration test proves
the field actually clears.

---

## Bug 2 — a double-click could race itself against Razorpay

### Symptom

The user reported: paying the deposit showed *"Something went wrong reaching the payment provider. Try
again"* — with the deposit already marked ✓ Done on the same page.

### What the evidence actually said

Railway's logs for `latch-viewer` showed two `POST /pay/:bookingId/deposit` requests two seconds apart,
one completing with `303` (success) and the other's completion arriving later, redirecting to the error
banner. Checked against Razorpay directly rather than assumed: the deposit order showed `attempts: 1`,
one payment, captured, no double charge. So the report wasn't a money-safety incident — it was a UX bug,
the losing side of a race surfacing a scary error even though the other side had already succeeded.

### Root cause

The pay page's Pay button had no disable-on-click guard, and the POST route had no defence against a
duplicate submission either — every POST unconditionally attempted a fresh S2S call.

### First fix attempt, and why it wasn't enough

Added a read-before-write check (`checkPendingLegStatus`, the same primitive `get_booking`'s live status
already uses) before submitting — if Razorpay already shows the leg done, redirect instead of
resubmitting. Shipped, tested against the fakes, redeployed.

Then verified it against the actual failure mode rather than assuming the fix held: fired two genuinely
simultaneous POSTs (`curl ... & curl ... & wait`, not sequential) at a fresh deposit leg. Both passed the
read-only check before either had submitted, and both proceeded to call Razorpay — producing two real
payments on the same order, one captured, one an orphaned `authorized` duplicate sitting on an order
that was already fully paid. A read-then-write check without atomicity narrows a race; it does not close
one.

The orphaned duplicate refused a refund (`"payment status should be captured for action to be taken"`)
— the same property already verified for manual-capture authorizations — confirming no money was
actually lost even in the worst-case reproduction. Still a real defect: an unexplained duplicate payment
record is exactly the kind of thing B1's audit trail exists to make impossible, not just harmless.

### Real fix

`withPayLock` — an in-process, per-`${bookingId}:${leg}` mutex serialising every POST for the same leg.
A queued duplicate's own read-before-write check now runs *after* the first request's submission has
actually landed, not concurrently with it.

In-process is the right scope for this deployment, not a shortcut taken to save time: `latch-viewer` runs
as a single Railway instance (`numReplicas: 1`, `docs/07-deployment.md`), so there is no second process
this lock would need to coordinate with. The comment on `withPayLock` says so explicitly, so the fix
doesn't quietly become wrong the day replica count changes — the honest fix at that point is a Postgres
advisory lock keyed the same way, not a bigger in-process map.

A new test fires two requests via `Promise.all` without awaiting in between — the same shape that
produced the real duplicate — and asserts the payment provider is called exactly once, not merely that
the responses look fine.

### Why the first fix looked sufficient and wasn't

`checkPendingLegStatus` alone passes every test that submits requests one at a time, including a naive
"does a duplicate get rejected" test. The gap only shows up under genuine concurrency, which nothing in
the existing suite exercised for this route. The lesson carried forward: a fix for a race condition isn't
verified by a test that doesn't actually race.

---

## What this session actually proved

Real Claude Desktop, connected to the deployed MCP endpoint, driving `find_slots → get_policy →
hold_slot → confirm_with_deposit`, followed by a real human paying both legs through the new S2S pay
page — the first time this exact path (third-party agent + human-paid UPI S2S, not a script) had been
exercised by someone other than the person building it. Both bugs it found were real, both are now
closed, and both are covered by tests that actually reproduce the failure mode rather than merely
assert the fix's happy path.

## Carried forward

- **The double-submit lock is in-process, tied to the current single-instance topology.** Documented as
  such in the code; revisit if `numReplicas` ever changes.
- **The orphaned duplicate payment from the reproduction** (`pay_TWTqPw5Jgsv7j6`, `authorized`, never
  captured) is harmless and left in the test-mode dashboard as evidence, same precedent dev-log 006 set
  for its own fixture payments.
