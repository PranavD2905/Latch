# Dev Log 031 — The first real payment, and the two silent bugs it exposed

**Date:** 30 August 2026
**Phase:** First end-to-end human-driven payment against the deployed environment
**Status:** Both bugs fixed, tested, deployed. `npm test`: 282/282 green.

---

## Why this entry exists

Every dev log from 006 onward carries the same caveat: **nobody had ever completed a real Razorpay
Checkout payment.** Automation could not — Razorpay's bot-resistance (hCaptcha + Sardine device
fingerprinting) blocks scripted card entry, and dev-logs 029 and 030 record the same wall being hit
again from a real, non-headless, extension-driven browser.

So the flow was proven up to order creation and page rendering, and no further. Everything past that
point was unit-tested, inferred, or assumed.

The user paid by hand today. It took three attempts, and each failure was informative. Two of the three
were real bugs in Latch, both of which would have been visible on camera, and **neither of which any
test could have caught** — one was a deployment-header interaction, the other was two correct
subsystems disagreeing about what "normal" means.

---

## Attempt 1 — my own bad instruction (not a bug)

The user's card payment failed. Razorpay's own record of the attempt:

```
pay_TW4JA5gEWakR2D  status=failed  method=card
  error_code   = BAD_REQUEST_ERROR
  error_step   = payment_initiation
  error_source = business
  error_reason = international_transaction_not_allowed
  description  = "this business accepts domestic (Indian) card payments only"
```

I had told the user to use `4111 1111 1111 1111`. That is one of Razorpay's **international** test
cards. This account accepts domestic only.

Razorpay's documented **domestic** test cards, for the record, since this will come up again:

| Network | Number |
|---|---|
| Visa (debit) | `4100 2800 0000 1007` |
| Mastercard (credit) | `5555 5100 0008 1006` |
| RuPay (credit) | `6527 6589 0000 1005` |

Any future expiry, any CVV.

**An unresolved contradiction, left standing rather than tidied away.** dev-log 006 states that this
slice's real captures were made *"all card (RuPay, via Razorpay's standard test card
`4111 1111 1111 1111`)"* — the same number that today returned
`international_transaction_not_allowed` on this account. Both cannot be straightforwardly true. Two
readings, and I cannot currently distinguish them:

- 006 recorded the card number inaccurately after the fact (it also calls `4111…` RuPay, which it is
  not — that is a Visa test number), and the three fixture payments were actually made with something
  else.
- The account's international-card setting changed between 23 and 30 August. The API keys were
  regenerated in that window (`rzp_test_TTAgw…` → `rzp_test_TVwd5…`), though the old fixture payments
  still resolve, which points at the same account rather than a new one.

006 is **not** being edited. A dev log records what was believed and observed at the time; silently
correcting one destroys its value as evidence. The discrepancy is noted here instead, where it
belongs, and it is worth resolving before the pitch if anyone quotes 006's card number again.

**Not a code defect.** Recorded because the wrong number is in this repo's own earlier guidance, and
because the diagnostic move is the reusable part: `orders.fetchPayments(orderId)` returns every
attempt with `error_code` / `error_reason` / `error_description` populated. Read those before
theorising. The failure named itself precisely.

---

## Bug 1 — COOP silently broke every popup-based payment method

### Symptom

The user switched to netbanking. Checkout redirected to a window showing **`about:blank`**. Nothing
loaded, no error appeared anywhere, and the payment never completed.

### What the evidence actually said

Three netbanking attempts on one order, all identical:

```
pay_TW4HVkUL8H3Kxi  status=created  method=netbanking
  error_code=null  error_step=null  error_source=null  error_reason=null
```

**`status=created` with every error field null.** That combination is the whole diagnosis: a decline
populates `error_code`; a failure populates `error_reason`. Null everywhere means *nothing failed* —
the payment was initiated and then simply never progressed. So the problem was not the payment. It was
the handoff.

### Root cause

Razorpay Checkout's netbanking and UPI flows open the bank page in a **popup** and post the result back
through `window.opener`.

`@fastify/helmet` sets, by default:

```
cross-origin-opener-policy: same-origin
```

which severs exactly that `window.opener` reference. The popup opens, cannot navigate, and sits on
`about:blank` forever.

Confirmed against the deployed page before changing anything:

```
$ curl -sI https://latch-viewer-production.up.railway.app/pay/<bookingId>
cross-origin-opener-policy:   same-origin
cross-origin-resource-policy: same-origin
```

### Why it survived this long

**Card payments open no popup.** Every prior verification of the pay page — dev-logs 029 and 030, and
my own — used cards, or stopped at page render. The bug was only reachable by a payment method nobody
had exercised, on a page that had only ever been half-tested.

dev-log 024 turned `contentSecurityPolicy` off for this server specifically because Checkout.js is a
cross-origin script load a default CSP would block. That reasoning was right, and it stopped one header
short: COOP breaks the same integration one step later in the flow, at the handoff rather than the
script load.

### Fix

`Cross-Origin-Opener-Policy: unsafe-none` and `Cross-Origin-Resource-Policy: cross-origin`, set **on
`GET /pay/:bookingId` only**. The viewer SPA opens no popups and keeps the stricter defaults —
verified both locally and against the deployed instance after redeploy.

Scoping it to the one route rather than the whole server matters: this is a real security relaxation,
and the blast radius should be the single page that provably needs it.

---

## Bug 2 — reconciliation alarming on a state a later feature made legitimate

### Symptom

With netbanking now working, the payment went through — and the audit trail immediately filled with:

```
HOLD_CREATED
POLICY_ACKNOWLEDGED
PAYMENT_REQUESTED
RECONCILIATION_MISMATCH   unrecorded_payment: trail said not_recorded, Razorpay says authorized (via webhook)
RECONCILIATION_MISMATCH   (same)
RECONCILIATION_MISMATCH   (same)
RECONCILIATION_MISMATCH   (same)
```

One per worker tick, on a booking that was behaving **entirely correctly**.

### Root cause

Two subsystems, each correct in isolation, disagreeing about what normal looks like.

**Reconciliation (dev-logs/014)** exists to catch one specific disaster: Latch crashes between Razorpay
confirming a capture and Latch appending the event. Real money moved, the trail has nothing. Its alarm
condition is *"Razorpay knows about a payment the trail does not."*

**The payment-link flow (dev-logs/029, 030)** hands the customer up to three pay links and deliberately
writes nothing until every applicable leg lands, in one atomic finalize. Its correctness rests on that
silence.

Those two facts are incompatible. Between "customer paid leg 1 of 3" and "all legs done", the system is
*by design* in the exact state reconciliation was built to treat as a disaster.

`grep -c "pendingPaymentLegs\|PAYMENT_REQUESTED" src/app/reconciliation.ts` → **0**. Reconciliation had
no awareness of the newer feature whatsoever.

### Fix

The webhook already resolved `entity.order_id` in order to find the booking — it simply never passed it
to `reconcileObservedPayment`. Now it does, and an observed payment whose order is **still listed** in
that booking's `pendingPaymentLegs` is treated as expected in-flight state.

The suppression is deliberately narrow, and that narrowness is the whole design:

- Only an order **still outstanding on that booking** is forgiven.
- Once finalize clears `pendingPaymentLegs` and records the real payment ids, a later stray payment is
  flagged exactly as before.
- The original dev-logs/014 case is untouched: a booking that crashed between capture and append has no
  pending leg for that payment either, so it still alarms.

Both halves are pinned by one test — the in-flight leg reports no mismatch, and a payment on an order
the booking never issued still reports one.

### Why this one mattered more than it looks

The audit trail is a **judged deliverable** under bar clause B5. Four false alarms per minute burying
the genuine events would have been plainly visible in the pitch video, and would have undermined the
exact claim the trail exists to make.

It is also the more interesting bug of the two. Nothing was broken. No component misbehaved. A
monitoring system did precisely what it was built to do, about a state that a feature written two days
later made legitimate. That class of defect — *correct code, stale assumption* — does not show up in
tests, because every test encodes the same assumption the code does.

---

## What this session actually proved

The first real payment through Latch, end to end:

```
find_slots → get_policy → hold_slot → confirm_with_deposit
  → PENDING + one pay link
  → human completes Razorpay Checkout (netbanking)
  → Razorpay webhook: authorized
```

The order was created server-side, the page rendered the right amount resolved from the database, the
link was handed to the user by a real agent over the deployed MCP endpoint, and a real human paid it.

Every dev log since 006 has carried "nobody has completed a real Checkout" as a caveat. **That caveat
is now closed for the deposit leg.**

---

## Carried forward

- **Partial-payment conversation still unexercised.** The specified flow — pay one leg, say "Paid",
  have the agent name the missing legs in plain language — has not been driven by a human yet. It is
  tested (dev-logs/030) but never observed live. This is the highest-value remaining check.
- **`session_complete_authorization` and `no_show_authorization` legs** have still never been completed
  by a human. Only the deposit leg has.
- **The no-deposit policy path** remains fakes-only, never driven live (dev-logs/030).
- **The domestic-vs-international test card distinction** should be checked wherever this repo's docs
  or prompts name a test card, since at least one wrong number was in circulation.

---

## Two candidates for the submission's failure-and-recovery story

Razorpay requires a story of a failure and the recovery from it. Both of today's qualify, and both are
stronger than the Reserve Pay dead end tracked in dev-logs/002, because both were found by a human
using the system rather than during research.

**The COOP bug** — a security header, added deliberately and for good reasons, silently broke payments.
No exception, no error code, no failed status. Just `status=created` forever and a blank popup. Found
by reading Razorpay's own attempt records and noticing every error field was null, which ruled out a
decline and pointed at the handoff instead of the payment.

**The reconciliation false positive** — the more sophisticated story of the two. Two subsystems, each
individually correct, holding incompatible beliefs about what a normal booking looks like mid-flight.
The fix was not to weaken the alarm but to teach it about a state that did not exist when it was
written.

The COOP one is easier to tell in thirty seconds. The reconciliation one is the better answer to *"tell
me about a hard bug."*
