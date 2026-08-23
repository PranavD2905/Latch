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

Seven MCP tools, exposed over Streamable HTTP so any remote agent can reach a deployed merchant
without a partnership or an integration deal.

| Tool | Does |
|---|---|
| `find_slots` | Live availability as (service × practitioner × start × duration), computed from working hours |
| `get_policy` | The machine-readable cancellation ladder, deposit rule, no-show terms, and mandate ceiling |
| `hold_slot` | Reserves capacity for a TTL. **No money.** Idempotency-keyed |
| `confirm_with_deposit` | Captures the deposit, registers the no-show mandate, confirms the booking |
| `reschedule` | Moves a booking. Same money, new time. Not a cancel-and-rebook |
| `cancel` | Applies the ladder from the server clock, refunds or retains accordingly |
| `charge_no_show` | Debits against the registered mandate after a missed appointment |

### 1.2 The properties that make it defensible

| Property | How |
|---|---|
| **Audit trail is the source of truth** | Event-sourced. State is a fold over events. The trail cannot drift from reality because it *is* reality |
| **Money actions cannot be unexplained** | The type system refuses a money event lacking action, gate, bound, and authority |
| **The no-show ceiling is enforced by Razorpay** | `max_amount` on the UPI Autopay mandate. Not an `if` statement in our code |
| **Double-booking is structurally impossible** | Postgres partial unique index, not application-level checking |
| **Agents cannot assert time** | Every time-dependent decision reads the server `Clock` port |
| **Retries cannot double-charge** | Idempotency keys on every money-moving tool |
| **Refusals are recorded** | An attempted breach is a permanent event, so bounds can be *demonstrated*, not just claimed |
| **Merchant decline unwinds autonomously** | Refund, mandate revoke, slot release, alternatives — one transaction, no human |
| **Policy is versioned** | A booking is judged under the ladder in force when it was made |

### 1.3 What ships in the buildathon build

- MCP server, all seven tools, deployed at a public HTTPS endpoint
- Postgres event store with the partial unique index and `FOR UPDATE` locking
- Razorpay test-mode integration: orders, capture, refunds, UPI Autopay mandate registration and debit
- Background worker: hold expiry, no-show eligibility
- Live audit trail viewer over SSE
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
| **Razorpay test mode only** | No real money moves; test-mode mandate behaviour may differ subtly from live | Required by the competition. Every flow is nonetheless a real API call, not a mock |
| **UPI Reserve Pay not used** | The brief proposed it; it has no public API (dev-log 001) | UPI Autopay mandate is used instead, and is *architecturally stronger*. Reserve Pay is the production evolution when its API ships |
| **Mandate pricing unknown** | Razorpay lists subscription pricing "on request"; per-mandate fees could change no-show economics | Flagged in `05-cost-model.md` §5. Does not affect correctness |
| **Events table grows unbounded** | By design — audit trails are not deleted. Becomes a real cost at ~9M rows/month (Tier 3) | Date-partitioning + cold storage. Designed for, not built |
| **Single region, single instance** | No HA. A Railway outage takes Latch down | Stateless app over one Postgres; horizontal scaling is a config change, not a rewrite |
| **No DPDP compliance work** | Clinic appointment data is health-adjacent under India's DPDP Act | Zero risk during the buildathon (synthetic data, test mode). A genuine cost before any real merchant — named in the cost model |
| **Reschedule price delta is simplified** | Handles a delta but does not model practitioner-tier pricing changes | The event carries the delta; richer pricing is a policy-schema change, not a state-machine change |
| **Merchant surface is minimal** | Enough to decline and mark non-attendance. Not a product | Demo surface was scoped to agent chat + live trail. The merchant controls exist to trigger the failure honestly |

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

**"Why is this Razorpay's problem and not a scheduling company's?"**

> Because the hard part is money, not time. A no-show charge is a debit against someone who received
> nothing — that needs a mandate, a ceiling, and an audit trail, which is payments infrastructure. A
> scheduler cannot build it without becoming a payments company. Razorpay already has the mandate
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
- Mandate registration with a real ceiling — this is B3, and the strongest claim we make
- The merchant-decline path end to end — this is B5, and it is half the bar
- The ladder boundary tests on a frozen clock — correctness of money is the product
- The concurrency test — one slot, two agents, exactly one winner

If the last five exist and nothing else does, the submission still makes its argument.
