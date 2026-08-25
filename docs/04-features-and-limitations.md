# Latch — Features and Limitations

**Status:** Decided
**Date:** 23 August 2026

Two lists. The second one is the more valuable of the two, and the reason is worth stating up front:

> A limitation you named before the judge found it is **scope discipline**.
> A limitation the judge found first is **a hole in your understanding**.

Everything below the line in §2 is deliberate. Nothing there is an accident being reframed.

---

## 1. What Latch does

### 1.1 The agent-facing surface

Eight MCP tools, exposed over Streamable HTTP so any remote agent can reach a deployed merchant
without a partnership or an integration deal.

| Tool | Does |
|---|---|
| `find_slots` | Live availability as (service × practitioner × start × duration), computed from working hours |
| `get_policy` | The machine-readable cancellation ladder, deposit rule, no-show terms, hold TTL, and hold rate ceiling |
| `get_booking` | Read-only status for one booking — no gate, no money, always safe to retry |
| `hold_slot` | Reserves capacity for a TTL. **No money.** Idempotency-keyed, and rate-limited per agent (dev-logs/014) |
| `confirm_with_deposit` | Captures the deposit, registers the no-show authorisation, confirms the booking |
| `reschedule` | Moves a booking. Same money, new time. Not a cancel-and-rebook |
| `cancel` | Applies the ladder from the server clock, refunds or retains accordingly |
| `charge_no_show` | Debits against the registered authorisation after a missed appointment |

Plus a second, read-only inbound surface proving the domain core is transport-agnostic (dev-logs/014):
`GET /slots`, plain REST, calling the identical `findSlots` function `find_slots` calls.

### 1.2 The properties that make it defensible

| Property | How |
|---|---|
| **Audit trail is the source of truth** | Event-sourced. State is a fold over events. The trail cannot drift from reality because it *is* reality |
| **Money actions cannot be unexplained** | The type system refuses a money event lacking action, gate, bound, and authority |
| **The no-show ceiling is enforced by Razorpay** | The authorised amount *is* the ceiling; capture must equal it. Not an `if` statement in our code |
| **Double-booking is structurally impossible** | Postgres partial unique index, not application-level checking |
| **Agents cannot assert time** | Every time-dependent decision reads the server `Clock` port |
| **Retries cannot double-charge** | Idempotency keys on every money-moving tool |
| **Refusals are recorded** | An attempted breach is a permanent event, so bounds can be *demonstrated*, not just claimed |
| **Merchant decline unwinds autonomously** | Refund, authorisation released, slot release, alternatives — one transaction, no human |
| **Policy is versioned** | A booking is judged under the ladder in force when it was made |
| **The trail is externally verified, not just internally consistent** | A reconciliation worker and a signature-verified Razorpay webhook both diff the trail against Razorpay's own record and append `RECONCILIATION_MISMATCH` on disagreement (dev-logs/014) |
| **Hold-spam has a named, mitigated bound** | `holdRateLimitPerMinute` caps request *rate*, not just concurrent-hold count — closes an inventory-denial gap the original design left unaddressed (dev-logs/014) |

### 1.3 What ships in the buildathon build

- MCP server, all eight tools, deployed at a public HTTPS endpoint
- A second, read-only REST inbound adapter (`GET /slots`), the same domain core underneath (dev-logs/014)
- Postgres event store with the partial unique index and `FOR UPDATE` locking
- Razorpay test-mode integration: orders, capture, refunds, card manual-capture authorisation registration and debit
- Background workers: hold expiry, no-show eligibility, authorisation lapse, and reconciliation against Razorpay's own record (dev-logs/014)
- A signature-verified `POST /webhooks/razorpay`, idempotent on Razorpay's own event identity, feeding the same reconciliation path in real time (dev-logs/014)
- A per-agent hold-request-rate ceiling, independent of the concurrent-hold ceiling (dev-logs/014)
- Live audit trail viewer over SSE, including the sunk-MDR cost line on every refund
- A minimal merchant control surface — enough to decline a booking and mark non-attendance
- Test suite: ladder boundaries on a frozen clock, concurrency race, full failure-path integration test

---

## 2. What Latch does not do

### 2.1 Deliberate non-goals — decided, not deferred

| Not built | Why not | What we'd say if asked |
|---|---|---|
| **Multi-tenancy** | One merchant, one Razorpay account. Multi-tenancy is engineering volume, not architectural insight | "Row-level `merchant_id` plus per-merchant Razorpay credentials. Mechanical, and it would have consumed the timeline" |
| **A calendar product** | We model slots minimally. The thesis is that calendar and money must be *one object to an agent* — not that Calendly should be rebuilt | "Real merchants have a scheduler. Latch should read theirs, not replace it" |
| **An AI receptionist** | The arrow points the other way (brief §3, Layer 3). Latch never speaks to a human | "Zenoti's AI answers the merchant's phone. Latch makes the merchant reachable by everybody else's agents" |
| **Agent identity verification** | That layer is occupied — Web Bot Auth, Visa TAP, NPCI UAP | "We assume an authenticated agent and compose with those rather than reinvent an IETF draft" |
| **An LLM anywhere in the money path** | Non-determinism in a payment flow is a defect | "`ALTERNATIVES_OFFERED` is a calendar query. Putting a model in a refund path would be a mistake" |
| **Notifications (SMS/WhatsApp/email)** | Real product need, zero architectural content | "An outbound adapter on the event stream. Two days, no design questions" |

### 2.2 Honest limitations of the build itself

These are real constraints on what will exist on submission day. Stated plainly.

| Limitation | Impact | Mitigation / path |
|---|---|---|
| **Razorpay test mode only** | No real money moves; test-mode authorisation behaviour may differ subtly from live | Required by the competition. Every flow is nonetheless a real API call, not a mock |
| **UPI Reserve Pay not used** | Activation-gated, no documented test-mode flow, and test-mode UPI returns success on cancellation regardless — which would silently break the release path (dev-log 005) | Card manual capture is the test-mode stand-in. Reserve Pay is named as the production rail, and the active rail is recorded on every money event |
| ⚠️ **Authorisations expire after 5 days** | `manual_expiry_period` maxes out at 7200 minutes. An appointment booked further out cannot carry a no-show authorisation on this rail | Demo books inside the window. A worker emits `AUTHORIZATION_LAPSED` so the system records losing its authority rather than failing silently. This limit is *why* Reserve Pay is the production rail |
| ⚠️ **First payment needs a human Checkout** | A standard test account cannot submit payments server-side; `/payments/create/upi` and `/payments/create/json` 404 pending TPV activation by Razorpay Support. Headless Checkout is blocked by hCaptcha + Sardine (dev-log 006) | Not a defect — this is AP2's *human-present* mode and B4's required gate. Everything after that first consent is autonomous. Applies to the no-show authorisation leg too, not just the deposit |
| **No void endpoint** | Razorpay documents no void/cancel API for an authorised payment | Release is by **lapse**: we simply never capture, and Razorpay auto-refunds at expiry. Customer cost stays ₹0, but release is asynchronous, not instant — the trail says so |
| **Events table grows unbounded** | By design — audit trails are not deleted. Becomes a real cost at ~9M rows/month (Tier 3) | Date-partitioning + cold storage. Designed for, not built |
| **Single region, single instance** | No HA. A Railway outage takes Latch down | Stateless app over one Postgres; horizontal scaling is a config change, not a rewrite |
| **No DPDP compliance work** | Clinic appointment data is health-adjacent under India's DPDP Act | Zero risk during the buildathon (synthetic data, test mode). A genuine cost before any real merchant — named in the cost model |
| **Reschedule price delta is simplified** | Handles a delta but does not model practitioner-tier pricing changes | The event carries the delta; richer pricing is a policy-schema change, not a state-machine change |
| **Merchant surface is minimal** | Enough to decline and mark non-attendance. Not a product | Demo surface was scoped to agent chat + live trail. The merchant controls exist to trigger the failure honestly |
| **The periodic reconciliation worker only scans CONFIRMED bookings** | A `HELD` booking whose deposit actually captured at Razorpay right before a crash (the exact gap-1 shape) is not found by the *periodic* pass — only by the webhook, and only if Razorpay's webhook delivery reaches Latch | The webhook is real-time and Razorpay retries non-2xx deliveries for days, so this is a narrow, bounded window, not an open gap — widening the periodic scan to `HELD` bookings too is a small follow-up, not a redesign |
| **The rate ceiling is a fixed 60s lookback, not a true sliding/leaky bucket** | An agent could in principle cluster requests right at a window boundary to get slightly more than `holdRateLimitPerMinute` in a worst case | Real, DB-verified, and closes the actual abuse shape (unbounded re-holding) — a token-bucket refinement is a tuning change, not a new mechanism |

### 2.3 The three questions a judge is most likely to ask

Prepared answers, because the brief (§7) is right that failing to answer these in 30 seconds kills the
idea.

**"Isn't this just Calendly plus a Razorpay payment link?"**

> Calendly lets a *human* book and pay as two separate acts, glued by a webhook. Latch lets an *agent*
> hold a slot, read a cancellation ladder, take a deposit, and charge a no-show as **one bounded
> transaction with an audit trail**. The proof it isn't glue: Razorpay↔Acuity is wired through Zapier
> today, where "Payment Captured" and "Appointment Scheduled" are unrelated events. An agent cannot
> reason about two unrelated events as one object.

**"Isn't this Zenoti?"**

> Opposite direction. Zenoti's AI receptionist answers a phone call *from* a human — inbound, at
> humans. Latch exposes the merchant *to* everyone else's agents — outbound, at machines. Zenoti has
> no `/.well-known` manifest, no MCP server, no agent-facing API. And they sit on top of a gateway;
> the money layer is not theirs to own.

**"Is it really end to end if a human still completes Checkout?"** ⭐ the likeliest challenge

> Yes — and the human step is the gate the bar asks for. B4 names *"a confirmation"* as its first
> example of what must stand between intent and execution.
>
> AP2, which Track 01 cites by name, defines **two** modes: *human-present* (real-time approval) and
> *human-not-present* (a human pre-signs a scoped mandate; the agent redeems it later with no clicks).
> Latch implements both, in the right places — the deposit is human-present, the no-show charge is
> human-not-present. ACP issues delegated tokens, Reserve Pay pre-approves a limit "with no **repeated**
> approvals." Every protocol in this space puts a human at the front and the agent behind it. An agent
> that could spend money with no consent at all isn't agentic commerce; it's an unauthorised
> card-not-present transaction.
>
> And empirically: **Razorpay's own MCP server cannot do it either.** `initiate_payment` requires a
> saved payment method from a prior human Checkout, then calls `submit_otp`. No tool in it creates a
> payment from zero (dev-log 006).
>
> Of the nine lifecycle actions an AI buyer performs against Latch, **eight need no human** — including
> the hardest one: a no-show debit executed weeks later against someone who received nothing, with no
> customer and no front desk present.

**"Why is this Razorpay's problem and not a scheduling company's?"**

> Because the hard part is money, not time. A no-show charge is a debit against someone who received
> nothing — that needs an authorisation, a ceiling, and an audit trail, which is payments infrastructure. A
> scheduler cannot build it without becoming a payments company. Razorpay already has the authorisation
> rails and no booking primitive to put on them (brief §3, Layer 4).

---

## 3. Scope discipline: what gets cut first

Ordered. If the timeline compresses, cut from the top.

1. Merchant policy *editor* UI → seed the policy in SQL
2. Reschedule price delta → reschedule at identical price only
3. Viewer polish (filtering, expandable detail) → flat live list
4. `find_slots` filters (practitioner preference, time windows) → next-available only
5. Multi-practitioner → one practitioner

**Never cut, in any scenario:**

- The event store and the four-field money event — *this is the project*
- Authorisation hold with a real ceiling — this is B3, and the strongest claim we make
- The merchant-decline path end to end — this is B5, and it is half the bar
- The ladder boundary tests on a frozen clock — correctness of money is the product
- The concurrency test — one slot, two agents, exactly one winner

If the last five exist and nothing else does, the submission still makes its argument.
