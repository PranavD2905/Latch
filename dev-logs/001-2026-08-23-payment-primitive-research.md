# Dev Log 001 — Choosing the payment primitive

**Date:** 23 August 2026
**Phase:** Pre-implementation / architecture
**Status:** Decided

---

## Why this log exists

The research brief (`agentic-services-transactability-brief.md`) closed with a risk table. The last
row was the one that could have killed the project:

> **UPI has no native authorisation/hold step.** Unlike cards, UPI is an instant debit. Verify what
> the reserve phase maps to in test mode — Reserve Pay, manual capture, or a simulated escrow — and
> state the constraint openly in the pitch rather than letting a judge discover it.

The whole design rests on two money primitives:

1. A **deposit** taken at booking time.
2. A **no-show charge** executed days or weeks later against a customer who received nothing.

(2) is the hard one. You cannot simply "remember the card". You need an authorisation captured at
booking, with a ceiling, that survives until the appointment and can be executed without the
customer present. This log records what was verified and what was chosen.

---

## What was checked

### Option A — Card authorise-then-capture (manual capture)

Razorpay supports it. Capture mode is configurable per-order via the Orders API
(`payment.capture: "manual"`), or globally in Dashboard → Account & Settings → Payment Capture.

**Verified blocker:** Razorpay's own docs state that payments left in the `authorized` state are
**auto-refunded within ~3 days** of creation. Uncaptured authorisations do not survive.

An appointment booked two weeks out therefore cannot hold its no-show authorisation as a card
auth. The authorisation would expire and silently refund long before the appointment happens.

> Verdict: **rejected as the no-show primitive.** Retained as a possible mechanism for the
> *deposit* leg only, where capture happens within minutes.

### Option B — UPI Reserve Pay

Razorpay's own launch material (FTX'26 / Sprint '26) describes it correctly: customers pre-approve a
spending limit against a brand and debit against it until exhausted. Conceptually this is exactly
the primitive the design wants.

**Verified blocker:** no public API reference could be found for it. It does not appear in the
Razorpay API docs tree, nor in the MCP tool surface (which covers Payments, Payment Links, Orders,
Refunds, QR Codes, Settlements, Payouts, Standard Checkout — no mandate/reserve tooling at all).

> Verdict: **cannot be built against today.** Named in the design as the production evolution path,
> not as the implementation.

### Option C — UPI Autopay mandate (recurring payments) ✅ CHOSEN

Documented, S2S-integrable, and available in test mode. Registration is a three-step flow:

1. `POST /v1/customers` → `customer_id`
2. `POST /v1/orders` with a `token` block → `order_id`
3. Create an authorisation payment (the ₹1 RBI-mandated auth transaction) → `payment_id` + `token_id`

The `token` block on the order carries the fields that matter:

```jsonc
{
  "amount": 100,                 // ₹1 authorisation transaction
  "currency": "INR",
  "customer_id": "cust_xxx",
  "method": "upi",
  "token": {
    "max_amount": 150000,        // paise — the hard ceiling
    "expire_at": 1893456000,     // unix ts — the mandate's own TTL
    "frequency": "as_presented"
  }
}
```

Later debits use the stored `token_id` against a fresh order, with no customer present.

---

## The decision, and why it is architecturally better than the brief assumed

**Chosen: UPI Autopay mandate as the no-show authorisation.**

The brief assumed Reserve Pay and treated the bound (bar clause **B3**, *bounded*) as something the
server would enforce. The mandate approach is strictly stronger:

> `max_amount` is enforced by **Razorpay**, not by our code.

A debit above the registered ceiling is rejected upstream, outside our trust boundary. This matters
for how the project is judged. "Bounded" implemented as a server-side `if` statement is a policy
check — it is only as trustworthy as the code around it, and a reviewer is entitled to ask what
happens when that code has a bug. A ceiling registered on the mandate at booking time is a
structural limit: even a fully compromised Latch server cannot debit ₹50,000 against a mandate
registered at ₹1,500.

That distinction — *detected* vs *impossible* — is exactly the language the track's bar uses:

> **B3:** A hard ceiling exists that the agent structurally cannot exceed. Detection after the fact
> does not count; the breach must be impossible, not merely caught.

So the bound is now enforced in two independent places:

| Layer | Bound | Enforced by |
|---|---|---|
| Policy | Deposit amount, ladder tier percentages | Latch server, against the merchant's policy record |
| Mandate | `max_amount` ceiling on any later debit | Razorpay, at the rail |

Belt and braces, with the outer brace outside our own code.

---

## Consequence for the slot hold

Worth stating plainly because it is easy to get confused here: **the slot hold is not a money hold.**

`hold_slot` reserves *capacity* — it writes a row with a TTL and makes the slot unavailable to other
agents. No payment object is created, no authorisation exists, nothing is reserved on the customer's
account. This is deliberate (brief §6.3: "Holds move no money. All risk is pushed into the cheap,
reversible phase.").

The three phases are therefore:

```
hold_slot            → capacity reserved, TTL ticking, ZERO money exposure
confirm_with_deposit → deposit captured + mandate registered (money enters)
charge_no_show       → debit against the registered mandate (money moves again)
```

The UPI-has-no-hold problem was never actually a problem for the hold phase. It was only ever a
problem for the no-show phase, and that is now solved.

---

## Open items carried forward

- [ ] Confirm test-mode behaviour of UPI Autopay end-to-end (test UPI IDs `success@razorpay` /
      `failure@razorpay` are documented for standard payments; mandate registration in test mode
      needs hands-on verification)
- [ ] Confirm whether the auth transaction must be ₹1 or can be the deposit amount itself — this
      decides whether booking is one payment or two
- [ ] Re-verify Razorpay changelog + UCP roadmap immediately before submission (brief §7)

---

## Sources

- https://razorpay.com/docs/payments/payments/capture-settings/
- https://razorpay.com/docs/payments/payments/capture-settings/api/
- https://razorpay.com/docs/payments/payment-gateway/s2s-integration/recurring-payments/upi/
- https://razorpay.com/docs/mcp-server/tools-reference/
- https://razorpay.com/docs/payments/payments/test-upi-details/
