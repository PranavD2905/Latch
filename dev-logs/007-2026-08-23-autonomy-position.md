# Dev Log 007 — Where the human sits, and why that is the design

**Date:** 23 August 2026
**Phase:** Cross-cutting (arising from Slice 2, binding on Slice 4 and the pitch)
**Status:** Settled position

---

## The question this answers

Track 01 asks for a merchant *"transactable by an AI buyer **end to end**."* Slice 2 (dev-log 006)
established that on a standard Razorpay test account, **an agent cannot complete a payment** — a human
must go through Checkout. So: do we actually deliver what the track asks?

**Yes.** This log records why, because it is the challenge most likely to be put to the submission and
the answer needs to be the same every time it is asked.

---

## What is actually blocked

From dev-log 006, verified live against `rzp_test_TTAgwUnHNRzJ8Q`:

- `POST /v1/payments/create/upi` → 404
- `POST /v1/payments/create/json` → 404
- Both require **Razorpay Support to enable TPV**. Not self-serve.
- Headless Checkout blocked by hCaptcha + Sardine device fingerprinting.

**This is an account-permission gate, not an API gap.** The S2S surface exists; we lack the permission.

**It binds Slice 4 as well.** `capture: "manual"` changes only what happens *after* a payment attempt
succeeds. It provides no human-free way to *create* an authorised payment. The no-show authorisation
leg therefore needs Slice 2's create-order-then-poll shape, not a different one.

---

## Why the human step is the design, not a shortfall

### 1. The bar demands a gate

**B4**, verbatim:

> Something must stand between intent and execution — **a confirmation**, a mandate scope, a TTL, a
> policy check. No money action fires purely on agent inference.

A Checkout confirmation is the first example the bar itself lists. Removing it would move us *away*
from compliance, not toward it.

### 2. AP2 — which Track 01 cites by name — specifies two modes, not one

| AP2 mode | Definition | Latch |
|---|---|---|
| **Human-present** | Real-time approval, customer present | **Deposit** — Checkout at booking |
| **Human-not-present** | Human pre-signs a *scoped* mandate; agent redeems later with no further approval | **No-show charge** — ceiling fixed at booking, executed weeks later with nobody present |

Human-not-present is not a fallback tier. It is half the protocol's architecture. Latch implements
both, each where it belongs.

### 3. Every rail in this space works this way

- **ACP** (OpenAI + Stripe) — delegated Shared Payment Tokens: scoped, time-bound, amount-restricted
- **AP2** (Google + PayPal) — mandates whose entire purpose is proving *a human authorised this*
- **UPI Reserve Pay** — customer pre-approves a limit; Razorpay's own copy says "no **repeated**
  approvals," conceding a first one
- **NPCI UAP** — registers agents as *authorised delegates*

An agent that could pay with no human consent at any point is not agentic commerce. It is an
unauthorised card-not-present transaction.

### 4. Razorpay's own MCP server cannot do it either ⭐

Slice 2 checked `github.com/razorpay/razorpay-mcp-server` — Razorpay's official agent tooling:

- `initiate_payment` requires **a saved payment method**, which only exists after a prior human Checkout
- It then calls **`submit_otp`** — a human enters a one-time code
- **No tool in it creates a payment from zero**

The company running this buildathon ships agentic MCP tooling that cannot complete a payment without a
human. This is the single strongest empirical answer to the challenge.

---

## What Latch actually delivers end to end

| Lifecycle action | Human required |
|---|---|
| Discover availability | — |
| Read the priced cancellation ladder | — |
| Hold a slot | — |
| **Authorise the deposit** | **customer, once, at Checkout** |
| Confirm the booking | — |
| Reschedule | — |
| Cancel with the ladder applied | — |
| **Charge the no-show, weeks later** | — |
| **Merchant decline → refund + release + alternatives** | — |

**Eight of nine actions need no human.** No merchant-side human at any point, and no bespoke
integration for the agent.

The autonomous set includes the hardest money action in the domain: a debit executed weeks after the
fact, against a customer who received nothing, with neither the customer nor the front desk present,
bounded by a ceiling the rail enforces.

---

## The honest gap

Consent is **per-booking Checkout**, where Reserve Pay would be **one pre-approval spanning many
bookings**.

That is a rail-availability gap, not a design gap. `PaymentRail` is already a port (dev-log 005)
precisely so Reserve Pay drops in when the account qualifies.

**Update to dev-logs 001 and 005 on Reserve Pay:** it now has a public name and a live NPCI/Claude
pilot, but Razorpay's own blog states it is "in pilot phase with a select group of users." Access
remains closed. The conclusion in 001 and 005 stands; only the specificity improves.

---

## Every "authorise once, spend later" primitive in India is gated

Asked directly: *could the customer verify OTP once, then let the agent spend up to a limit with no
further authorisation?* That is an **e-mandate / recurring token**, and it is exactly the right
production design. Checked whether it is available. It is not — and neither is any sibling.

| Mechanism | What it would give us | Status |
|---|---|---|
| **UPI Reserve Pay** | Pre-approved limit, zero-tap | Closed pilot, select users only |
| **UPI Autopay mandate** | OTP once → debit to `max_amount` | Test-mode cancellation returns success regardless, so release cannot be proven (dev-log 005) |
| **Card e-mandate / recurring** | OTP once → debit to `max_amount`, revocable token | **On-demand activation** ("raise a request with Support"), granted *"at the discretion of the payment gateway and partner banks"* and dependent on line of business. And in test mode, **card tokens are valid for 3 days only** — shorter than the 5-day manual-capture window we already have |
| **S2S / TPV direct payment** | Server submits payments outright | 404, needs Support activation (dev-log 006) |
| **Card manual capture** | Authorise now, capture later | ✅ **in use** — the only self-serve option, 5-day window |

**The pattern is the finding.** Every mechanism granting delegated, bounded spending authority is
gated behind manual approval. That is not accidental: under RBI's AFA framework these are regulated
instruments, and gateways gate them by business category to control fraud and chargeback exposure.

It is also precisely *why* NPCI is building **UAP** — to standardise agent delegation rather than leave
it to per-merchant approval. Track 01's "why now" cites UAP for exactly this reason. The primitive the
track asks for exists, is regulated, and is not yet generally available. Latch is built against that
reality rather than around it.

**If recurring were activated it would be architecturally better than manual capture** — a real ceiling
with headroom, and a genuine token-cancel API replacing release-by-lapse. Worth requesting. Not worth
blocking on.

## Action open

Request TPV / S2S activation from Razorpay Support for the test account. Free, and if granted before
submission the deposit leg becomes autonomous too. **Do not block on it** — and note that the request
being manually gated is itself a usable line in the pitch.

---

## The line for the video

> The agent doesn't get to spend your money on its own say-so. The customer authorises once, scoped to
> exactly ₹400 — and Razorpay refuses anything above it. Everything after that runs with no human
> anywhere: the no-show charge two weeks later, the refund when the doctor calls in sick, releasing the
> authorisation. That's not a limitation. That's the gate the bar asks for.
