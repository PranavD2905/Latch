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
without a partnership or an integration deal. (An eighth, `charge_no_show`, existed through Slice 4 and
was removed as a feature — see the dev log for that removal.)

| Tool | Does |
|---|---|
| `find_slots` | Live availability as (service × practitioner × start × duration), computed from working hours |
| `get_policy` | The machine-readable cancellation ladder, deposit rule, hold TTL, and hold rate ceiling |
| `get_booking` | Read-only status for one booking — no gate, no money, always safe to retry |
| `hold_slot` | Reserves capacity for a TTL. **No money.** Idempotency-keyed, and rate-limited per agent (dev-logs/014) |
| `confirm_with_deposit` | Captures the deposit, registers the session-complete authorisation, confirms the booking |
| `reschedule` | Moves a booking. Same money, new time. Not a cancel-and-rebook |
| `cancel` | Applies the ladder from the server clock, refunds or retains accordingly |

Plus a second, read-only inbound surface proving the domain core is transport-agnostic (dev-logs/014):
`GET /slots`, plain REST, calling the identical `findSlots` function `find_slots` calls.

### 1.2 The properties that make it defensible

| Property | How |
|---|---|
| **Audit trail is the source of truth** | Event-sourced. State is a fold over events. The trail cannot drift from reality because it *is* reality |
| **Money actions cannot be unexplained** | The type system refuses a money event lacking action, gate, bound, and authority |
| **The session-complete ceiling is enforced by Razorpay** | The authorised amount *is* the ceiling; capture must equal it. Not an `if` statement in our code |
| **Double-booking is structurally impossible** | Postgres partial unique index, not application-level checking |
| **Agents cannot assert time** | Every time-dependent decision reads the server `Clock` port |
| **Retries cannot double-charge** | Idempotency keys on every money-moving tool |
| **Refusals are recorded** | An attempted breach is a permanent event, so bounds can be *demonstrated*, not just claimed |
| **Merchant decline unwinds autonomously** | Refund, authorisation released, slot release, alternatives — one transaction, no human |
| **Policy is versioned** | A booking is judged under the ladder in force when it was made |
| **The trail is externally verified, not just internally consistent** | A reconciliation worker and a signature-verified Razorpay webhook both diff the trail against Razorpay's own record and append `RECONCILIATION_MISMATCH` on disagreement (dev-logs/014) |
| **Hold-spam has a named, mitigated bound** | `holdRateLimitPerMinute` caps request *rate*, not just concurrent-hold count — closes an inventory-denial gap the original design left unaddressed (dev-logs/014) |

### 1.3 What ships in the buildathon build

- MCP server, all seven tools, deployed at a public HTTPS endpoint
- A second, read-only REST inbound adapter (`GET /slots`), the same domain core underneath (dev-logs/014)
- Postgres event store with the partial unique index and `FOR UPDATE` locking
- Razorpay test-mode integration: orders, capture, refunds, card manual-capture authorisation registration and debit
- Background workers: hold expiry, authorisation lapse, and reconciliation against Razorpay's own record (dev-logs/014)
- A signature-verified `POST /webhooks/razorpay`, idempotent on Razorpay's own event identity, feeding the same reconciliation path in real time (dev-logs/014)
- A per-agent hold-request-rate ceiling, independent of the concurrent-hold ceiling (dev-logs/014)
- Live audit trail viewer over SSE, including the sunk-MDR cost line on every refund
- A minimal merchant control surface — enough to decline a booking and mark non-attendance
- A merchant policy editor in the viewer (`POST`/`GET /policy`, dev-logs/015 — reinstated, see §3): publishing is
  an INSERT of a new version, never an UPDATE, so a booking confirmed under vN keeps cancelling under vN even
  after the merchant publishes vN+1
- Test suite: ladder boundaries on a frozen clock, concurrency race, full failure-path integration test

---

## 2. What Latch does not do

### 2.1 Deliberate non-goals — decided, not deferred

| Not built | Why not | What we'd say if asked |
|---|---|---|
| ~~**Multi-tenancy**~~ — superseded by migration 0011 (docs/01-architecture.md §10) | Was: one merchant, one Razorpay account. Real multi-tenancy shipped once the schedule allowed it — row-level `merchant_id`, per-merchant DB-issued credentials, no redeploy to onboard a merchant | Kept here, struck through, for the same reason §10 keeps its own entry: a decision later reversed is worth showing as a decision, not silently deleted |
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
| ⚠️ **Authorisations expire after 5 days** | `manual_expiry_period` maxes out at 7200 minutes. An appointment booked further out cannot carry a session-complete authorisation on this rail | Demo books inside the window. A worker emits `SESSION_COMPLETE_AUTHORIZATION_LAPSED` so the system records losing its authority rather than failing silently. This limit is *why* Reserve Pay is the production rail |
| ⚠️ **First payment needs a human Checkout** | A standard test account cannot submit payments server-side; `/payments/create/upi` and `/payments/create/json` 404 pending TPV activation by Razorpay Support. Headless Checkout is blocked by hCaptcha + Sardine (dev-log 006) — reconfirmed directly by a second session driving real Checkout.js through a genuine (non-headless) browser: clicks and keystrokes land nowhere in the card-entry fields at all, which is Razorpay's own bot-resistance working as intended, not an automation gap on our side | Not a defect — this is AP2's *human-present* mode and B4's required gate. Everything after that first consent is autonomous. Applies to the session-complete authorisation leg too, not just the deposit. `confirm_with_deposit` hands the agent a real pay link per outstanding leg (dev-logs entry, payment-link feature) rather than blocking in-process — the human still has to be the one who clicks it |
| **No void endpoint** | Razorpay documents no void/cancel API for an authorised payment | Release is by **lapse**: we simply never capture, and Razorpay auto-refunds at expiry. Customer cost stays ₹0, but release is asynchronous, not instant — the trail says so |
| **Events table grows unbounded** | By design — audit trails are not deleted. Becomes a real cost at ~9M rows/month (Tier 3) | Date-partitioning + cold storage. Designed for, not built |
| **Single region, single instance** | No HA. A Railway outage takes Latch down | Stateless app over one Postgres; horizontal scaling is a config change, not a rewrite |
| **No DPDP compliance work** | Clinic appointment data is health-adjacent under India's DPDP Act | Zero risk during the buildathon (synthetic data, test mode). A genuine cost before any real merchant — named in the cost model |
| **Reschedule price delta is simplified** | Handles a delta but does not model practitioner-tier pricing changes | The event carries the delta; richer pricing is a policy-schema change, not a state-machine change |
| **Merchant surface is minimal** | Decline, mark a session complete, and (dev-logs/015) publish a new policy version. Not a product | Demo surface was scoped to agent chat + live trail, plus the one write path (`set_policy`) worth making visible — see §3 |
| **The periodic reconciliation worker only scans CONFIRMED bookings** | A `HELD` booking whose deposit actually captured at Razorpay right before a crash (the exact gap-1 shape) is not found by the *periodic* pass — only by the webhook, and only if Razorpay's webhook delivery reaches Latch | The webhook is real-time and Razorpay retries non-2xx deliveries for days, so this is a narrow, bounded window, not an open gap. Revised from an earlier draft of this row: "widening the periodic scan to `HELD` bookings" turns out not to be the small follow-up it reads as — `detectKnownReferenceMismatches` (`reconciliation.ts`) only checks a `razorpayId` already recorded in the trail or on the projection, and a booking stuck exactly this way has neither; there is nothing for a widened scan to check without a receipt-lookup capability this codebase doesn't have. What *did* close, directly: the single most likely real trigger for this shape wasn't a process crash at all — it was `confirm_with_deposit`'s own `Promise.all` discarding an already-captured deposit whenever either concurrent optional leg failed. That's fixed at the source (switched to `Promise.allSettled`; see the confirm-with-deposit.ts commit and its chaos test). What remains is narrower than before: a genuine process crash between the payment call returning and the final transaction committing, which no in-process `Promise` handling can reach — that residual case is still webhook-and-retries only |
| **The rate ceiling is a fixed 60s lookback, not a true sliding/leaky bucket** | An agent could in principle cluster requests right at a window boundary to get slightly more than `holdRateLimitPerMinute` in a worst case | Real, DB-verified, and closes the actual abuse shape (unbounded re-holding) — a token-bucket refinement is a tuning change, not a new mechanism |
| **No merchant-wide hold-rate ceiling, only per-agent-per-merchant (dev-logs/016)** | `holdRateLimitPerMinute` bounds one `agentId`; a large number of *distinct* hostile agent ids, each staying under its own ceiling, could still collectively spam one merchant's calendar. Sharper than dev-logs/016 originally framed it: this doesn't need independently-run attackers coordinating — `agentId` is a caller-supplied, unverified string (a direct consequence of "No agent identity verification" below, §2.1), so *one* attacker holding one valid merchant credential can defeat every per-agent ceiling alone, just by generating a fresh `agentId` on each request | Bounded, not open: reaching this surface at all still needs a valid per-merchant credential (migration 0011), and every request — regardless of how many `agentId`s it claims to be — still counts against the flat per-caller-IP transport ceiling `POST /mcp/:merchantId` enforces (dev-logs/entry for MCP rate limiting, `streamable-http-server.ts`). Rotating `agentId` collapses the fine-grained per-agent ceiling down to that coarser IP ceiling; it does not remove bounding entirely. Building real per-agent identity to close this fully is exactly the layer named out of scope below — the honest fix is composing with an external standard, not a bigger local rate-limit table |
| **No formal outbox table for payment-authorization ↔ event-append atomicity (dev-logs/016)** | Between a real Razorpay call and the event that records it, a crash could in principle leave the two out of step | Evaluated, not skipped: every money-moving handler already uses the gate-transaction / network-call-outside-any-lock / final-transaction shape (dev-logs/004), and the reconciliation worker + webhook (dev-logs/014, dev-logs/016) independently verify the *outcome* against Razorpay's own record — which is what an outbox is ultimately for. A formal outbox adds a table, a relay process, and a new failure mode of its own to catch the same drift this system already catches by asking the payment provider directly, which is strictly stronger (it verifies against ground truth, not against a second local write) |
| **`get_booking`/`find_slots` fold every read from the full event history, no snapshotting** | Read latency grows with a booking's event count — real, but currently small (a handful of events per booking, `docs/03-domain-model.md`'s event catalogue) | Evaluated this session (dev-logs/016) and deliberately not built: this is a buildathon-scale demo without real event-history depth yet to make snapshotting pay for itself, and it would add a second representation of booking state to keep consistent with the fold — exactly the kind of drift risk B1's "the trail *is* reality" claim exists to avoid. Named here as the scaling plan (a `booking_snapshots` table, invalidated by sequence number, same as most event-sourced systems do it) rather than built speculatively |

### 2.3 The three questions a judge is most likely to ask

Prepared answers, because the brief (§7) is right that failing to answer these in 30 seconds kills the
idea.

**"Isn't this just Calendly plus a Razorpay payment link?"**

> Calendly lets a *human* book and pay as two separate acts, glued by a webhook. Latch lets an *agent*
> hold a slot, read a cancellation ladder, take a deposit, and capture the session-complete mandate as
> **one bounded transaction with an audit trail**. The proof it isn't glue: Razorpay↔Acuity is wired
> through Zapier today, where "Payment Captured" and "Appointment Scheduled" are unrelated events. An
> agent cannot reason about two unrelated events as one object.

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
> Latch implements both, in the right places — the deposit is human-present, and the session-complete
> mandate is authorised human-present at booking but *captured* human-not-present, weeks later, the
> instant the merchant marks the session complete — no new click from the customer at capture time. ACP
> issues delegated tokens, Reserve Pay pre-approves a limit "with no **repeated** approvals." Every
> protocol in this space puts a human at the front and the agent behind it. An agent that could spend
> money with no consent at all isn't agentic commerce; it's an unauthorised card-not-present
> transaction.
>
> And empirically: **Razorpay's own MCP server cannot do it either.** `initiate_payment` requires a
> saved payment method from a prior human Checkout, then calls `submit_otp`. No tool in it creates a
> payment from zero (dev-log 006).
>
> Of the lifecycle actions an AI buyer performs against Latch, most need no further human step once the
> initial Checkout consent is given — including the hardest one: capturing the session-complete mandate
> weeks after booking, against a ceiling fixed at authorisation time, with no customer and no front desk
> present at capture.

**"Why is this Razorpay's problem and not a scheduling company's?"**

> Because the hard part is money, not time. A debit against a service that may not have been fully
> consumed yet needs an authorisation, a ceiling, and an audit trail, which is payments infrastructure. A
> scheduler cannot build it without becoming a payments company. Razorpay already has the authorisation
> rails and no booking primitive to put on them (brief §3, Layer 4).

---

## 3. Scope discipline: what gets cut first

Ordered. If the timeline compresses, cut from the top.

1. ~~Merchant policy *editor* UI → seed the policy in SQL~~ **Reinstated, dev-logs/015.** The schedule
   allowed it, and it was worth building for real: it's the only way to make `policy_version`'s
   retroactivity claim (§2's B2 discussion, `docs/03-domain-model.md` §2) demonstrable rather than
   asserted — before this, nothing could ever publish a v5, so "a booking made under v4 keeps cancelling
   under v4" had no second version to actually test against.
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
