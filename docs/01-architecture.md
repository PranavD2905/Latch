# Latch — Architecture

**Status:** Decided, pre-implementation
**Date:** 23 August 2026
**Companion docs:** `02-tech-stack.md` (what we build it with and why), `03-domain-model.md` (the state
machine in detail), `04-features-and-limitations.md` (honest scope)

---

## 0. The one-paragraph version

Latch is a **service-transaction layer**. It sits on top of a single Indian service merchant's
Razorpay account and exposes that merchant to *any* third-party AI agent as something that can be
transacted with — not merely booked. The agent-facing surface is an MCP server with eight tools. The
core is an event-sourced domain model where the audit trail is not a log written beside the truth;
the audit trail **is** the truth. Money bounds are enforced twice: once by our policy engine, and
once by Razorpay itself at the payment rail, so that even a fully compromised Latch server cannot
exceed the ceiling a customer consented to.

---

## 1. The three ideas that shape everything

Before any diagram, three decisions. Everything else in this document follows from them. If you only
remember three things about this architecture, remember these.

### Idea 1 — The audit trail is the database, not a log next to it

**The normal way** to build this would be: keep a `bookings` table with a `status` column, update it
as things happen, and write log lines alongside so you can see what happened.

The problem is that those are two separate acts. The `UPDATE` can succeed and the log line can fail.
The log can say one thing and the row another. Over time they drift, and now your audit trail is a
*claim* about what happened rather than a *record* of it.

**We invert it.** Nothing is ever updated. Every change is a new immutable row appended to an
`events` table. The current state of a booking is *computed* by replaying its events in order.

```
Traditional:   [state table] ──updates──> truth
                     │
                     └──logs──> audit trail (a second, weaker copy)

Latch:         [event log] ──is──> truth
                     │
                     └──folded into──> state (a derived, disposable view)
```

Why this is the right call *for this project specifically*, not just good practice:

The track's bar clause **B5** says *"Show the audit trail."* If the trail is a side-effect, a judge is
entitled to ask whether it's complete. If the trail is the source of truth, the question dissolves —
the system **cannot** move money without appending an event, because the event *is* the money moving.
You cannot forget to log what you did, because logging it is how you do it.

It also hands us the demo for free: replay the event log and the entire booking history reconstructs
itself, which is exactly what we render in the live viewer.

### Idea 2 — The event schema forces the bar's four clauses

This is the sharpest idea in the design, so read it twice.

The bar decomposes into B1 (every money action), B2 (explainable), B3 (bounded), B4 (gated). Most
submissions will satisfy these by *remembering* to satisfy them — writing good log messages,
adding checks.

We make it structural. Every money-moving event **must** carry four fields, enforced by the type
system:

```ts
type MoneyEvent = {
  action:    MoneyAction   // B1 — which rupee moved, and in which direction
  gate:      GateCleared   // B4 — the precondition that was satisfied to permit it
  bound:     BoundApplied  // B3 — the ceiling it ran against, and who enforces that ceiling
  authority: AuthorityRef  // B2 — the policy version / authorisation id that granted permission
  // ...amount, timestamps, ids
}
```

There is no constructor for a money event that omits them. The consequence:

> **It is not possible to write code in this system that moves money without explaining itself.**

That is a materially different claim from "we log our money movements well," and it is the sentence
worth saying in the pitch video.

### Idea 3 — Bounds are enforced outside our own trust boundary

Covered in full in `dev-logs/005` (which supersedes the rail choice in `dev-logs/001`). In summary:

A no-show charge is a debit against a customer who received nothing. That is the most abusable action
in the entire system, so it gets the strongest possible bound.

At booking we place a **card authorisation** (`capture: "manual"`) for **exactly** the no-show fee. It
sits in `authorized` — the customer is not charged. Later, `charge_no_show` captures it.

The bound is the authorised amount itself, and Razorpay enforces it: the Capture API rejects any
capture that is not equal to the amount authorised (*"Capture amount must be equal to the amount
authorized"*). We cannot capture a rupee more, and because the authorisation is taken at exactly the
fee, **there is no headroom to abuse at all.**

| Bound | Value | Enforced by | Can a Latch bug defeat it? |
|---|---|---|---|
| Deposit amount | From merchant policy record | Latch policy engine | Yes, in principle |
| Ladder retention % | From merchant policy record | Latch policy engine | Yes, in principle |
| Concurrent holds per agent | Configured per agent | Latch + DB constraint | No — DB constraint |
| Double-booking a slot | One booking per (practitioner, start) | **Postgres partial unique index** | **No** |
| **No-show debit ceiling** | The authorised amount, taken at exactly the fee | **Razorpay, at the rail** | **No** |

The bottom three rows are the ones that matter. B3 demands the breach be *"impossible, not merely
caught."* For those three, it genuinely is.

**The rail is named in the trail.** Every money event carries `rail: 'manual_capture' | 'reserve_pay'`.
Manual capture is the **test-mode stand-in**; UPI Reserve Pay is the **production rail** and is not
built (`dev-logs/005`). Since the trail is a judged deliverable under B5, it must never imply the
production rail was exercised when it was not.

---

## 2. System diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  ANY THIRD-PARTY AGENT                                               │
│  Claude · ChatGPT · a user's personal agent · another merchant's bot │
│  Latch does not know or care which. That is the entire point.        │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  MCP over Streamable HTTP
                             │  (8 tools, Zod-validated)
╔════════════════════════════▼═════════════════════════════════════════╗
║  INBOUND ADAPTERS                                                    ║
║                                                                      ║
║  ┌────────────────┐  ┌──────────────────┐  ┌───────────────────┐     ║
║  │ MCP Server     │  │ Merchant API     │  │ SSE Stream        │     ║
║  │ find_slots     │  │ decline_booking  │  │ live audit trail  │     ║
║  │ get_policy     │  │ mark_no_show     │  │ → viewer UI       │     ║
║  │ hold_slot      │  │ set_policy       │  │                   │     ║
║  │ confirm_...    │  │                  │  │                   │     ║
║  │ reschedule     │  │ (this is where   │  │                   │     ║
║  │ cancel         │  │  the FAILURE is  │  │                   │     ║
║  │ charge_no_show │  │  triggered)      │  │                   │     ║
║  └────────┬───────┘  └────────┬─────────┘  └─────────▲─────────┘     ║
╚═══════════╪═══════════════════╪══════════════════════╪═══════════════╝
            │                   │                      │
            │  Commands — plain typed objects.         │  Events
            │  No HTTP types, no MCP types, no         │
            │  Razorpay types cross this line.         │
            │                   │                      │
╔═══════════▼═══════════════════▼══════════════════════╪═══════════════╗
║  DOMAIN CORE — pure functions, zero I/O              │               ║
║                                                      │               ║
║   ┌──────────────────────────────────────────────────┴────────────┐  ║
║   │  Booking state machine                                        │  ║
║   │  Cancellation ladder evaluator  (server clock only)           │  ║
║   │  Policy engine — evaluates every gate (B4) and bound (B3)     │  ║
║   │  Money — integer paise, branded type, never a float           │  ║
║   │                                                               │  ║
║   │  Signature of the whole core, essentially:                    │  ║
║   │     (currentState, command, clock, policy) → Event[] | Refusal │ ║
║   │                                                               │  ║
║   │  It DECIDES. It never performs. It cannot call Razorpay,      │  ║
║   │  cannot read the clock, cannot touch the database.            │  ║
║   └───────────────────────────────┬───────────────────────────────┘  ║
╚═══════════════════════════════════╪══════════════════════════════════╝
                                    │  ports (TypeScript interfaces)
╔═══════════════════════════════════▼══════════════════════════════════╗
║  OUTBOUND ADAPTERS                                                   ║
║                                                                      ║
║  ┌──────────────────┐ ┌───────────────┐ ┌────────────┐ ┌──────────┐  ║
║  │ PaymentProvider  │ │ EventStore    │ │ SlotRepo   │ │ Clock    │  ║
║  │ → Razorpay       │ │ → Postgres    │ │ → Postgres │ │ → system │  ║
║  │ → FakeProvider   │ │   append-only │ │   partial  │ │ → Frozen │  ║
║  │   (tests)        │ │               │ │   unique   │ │  (tests) │  ║
║  └────────┬─────────┘ └───────────────┘ └────────────┘ └──────────┘  ║
╚═══════════╪══════════════════════════════════════════════════════════╝
            │
            ▼
   Razorpay test mode
   Orders · Payments · Refunds · card manual-capture authorisations
```

**Not redrawn above, added in dev-logs/014, both riding on the existing three-service topology
(`docs/07-deployment.md`) rather than a new one:**

- **`GET /slots`** — a fourth inbound adapter box, conceptually next to "Merchant API": plain REST,
  read-only, mounted on the merchant API's own Fastify instance. Calls the identical `findSlots`
  app-layer function `find_slots` calls — see §1's "architecture is the argument" callout above, now
  demonstrated rather than only claimed.
- **`POST /webhooks/razorpay`** — an inbound arrow from Razorpay itself (the box at the bottom of this
  diagram), not from an agent. Signature-verified, and its only possible effect is a
  `RECONCILIATION_MISMATCH` event via the same path the periodic reconciliation worker uses — see §11.
- **Reconciliation worker** — a fifth outbound-adapter consumer, reusing `PaymentProvider`/`PaymentRail`
  read-only (`fetchPaymentStatus`/`fetchAuthorizationStatus`) to verify the trail against Razorpay's own
  record — see §8.

### Why the domain core is isolated

Two reasons, and the second is strategic rather than technical.

**Technical:** the entire money state machine — every gate, every bound, every ladder computation —
becomes testable without a network, a database, or a clock. We can assert "cancelling 13 hours before
a ₹800 appointment retains exactly ₹400" as a pure unit test that runs in under a millisecond. Given
that the correctness of money movement is the whole product, this is not optional.

**Strategic:** the novelty claim in the brief (§5) is that this is a *protocol-level* gap — that no
protocol models an appointment. If our appointment semantics were tangled into MCP handlers and
Razorpay SDK calls, that claim would be rhetoric. Because the core is transport-agnostic and
provider-agnostic, the claim is demonstrable: the same domain could be exposed over UCP, A2A, or plain
REST by writing another inbound adapter, and could settle over any provider by writing another
outbound one. **The architecture is the argument.**

**Demonstrated, not just asserted, as of dev-logs/014.** `GET /slots`
(`src/adapters/rest/slots.ts`) is a second inbound adapter — plain REST, no MCP, no JSON-RPC — that
calls the exact same `findSlots` app-layer function (`src/app/find-slots.ts`) the MCP `find_slots` tool
calls, with zero changes to `src/domain/` or `src/app/` to add it. `registerSlotsRoute` is a plain
function that mounts onto any `FastifyInstance`; `src/adapters/rest/server.ts` uses it for a genuinely
standalone REST server, and `src/adapters/merchant-api/server.ts` mounts the identical function onto
its own already-deployed, already-public Fastify instance for real reachability without provisioning a
fourth Railway service. A judge can now `curl` both surfaces and confirm they return byte-identical
results for the same query, because there is only one implementation underneath.

---

## 3. The eight tools, and where the risk lives

From brief §6.2, with the enforcement point named for each. `get_booking` is a Slice 7 addition, not
from the original brief — see below.

| Tool | Money | Gate (B4) | Bound (B3) | Bound enforced by |
|---|---|---|---|---|
| `find_slots` | none | — | — | — |
| `get_policy` | none | — | — | — |
| `get_booking` | none | — | — | — |
| `hold_slot` | **none** | Slot free at request time | Max concurrent holds/agent; TTL | DB constraint + Latch |
| `confirm_with_deposit` | deposit capture | Live unexpired hold **and** policy acknowledged | Policy deposit amount; authorisation ceiling | Latch + **Razorpay** |
| `reschedule` | price delta only | Target free; ladder permits move now | Delta ≤ original booking value | Latch |
| `cancel` | refund / retention | Booking exists; tier from **server clock** | Retention ≤ ladder tier for true timestamp | Latch |
| `charge_no_show` | debit | Start time elapsed **and** merchant marked non-attendance | The authorised amount | **Razorpay** |

**Why `get_booking` exists.** `confirm_with_deposit` can take minutes in practice — it blocks on a real
human completing Razorpay Checkout — and a long-held HTTP response is exactly the kind of thing an
intermediate proxy can kill while the server keeps working underneath it (dev-logs/012, hit for real
against the Slice 7 deployment). Before this tool, an agent facing a dead connection after a write had
nothing to check against — `find_slots` can't distinguish a live hold from a confirmed booking, let alone
report deposit or authorisation state. `get_booking` is the one call that's always safe to retry: no
gate, no money, just the truth of what the server already did.

Note the shape of the risk curve. `hold_slot` is the most frequently called tool and carries **zero**
money exposure — that is deliberate (brief §6.3: *"All risk is pushed into the cheap, reversible
phase"*). An agent can hammer `hold_slot`, get it wrong, crash, or retry blindly, and the worst
outcome is a slot that unlocks itself in ten minutes.

`charge_no_show` is the rarest call and the most dangerous, so it carries a gate requiring **two
independent facts** — elapsed time (which the server owns) *and* an explicit merchant action (which no
agent can forge) — plus a ceiling enforced by a third party.

---

## 4. Concurrency: overselling is a real threat, not a hypothetical

The brief held "concurrency across agent surfaces" as a backup idea (Appendix A) and noted that UCP's
last-writer-wins session model has no optimistic concurrency control. We absorb that problem here
rather than treating it as separate.

Agents transact at machine speed and in parallel. Two agents can call `hold_slot` on the same
3pm Thursday slot microseconds apart. Application-level checking — *read, see it's free, write* —
loses this race, and the failure mode is double-booking a real doctor.

**Our answer is a storage-layer constraint, not application logic:**

```sql
CREATE UNIQUE INDEX one_live_booking_per_slot
  ON bookings (practitioner_id, starts_at)
  WHERE status IN ('held', 'confirmed');
```

The second writer's transaction fails at the database. There is no window to lose. We catch the
constraint violation and return a clean `SLOT_TAKEN` refusal to the losing agent.

This is the same principle as Idea 3: push the guarantee down to a layer that cannot be talked out of
it. An `if` statement can be raced. A unique index cannot.

---

## 5. Time: the server clock is the only clock

Every time-dependent decision — is the hold still alive, which ladder tier applies, has the
appointment start elapsed — is computed from the server's clock, reading a `Clock` port.

An agent may *say* it is calling at 2pm. We do not care. The ladder tier is derived from
`clock.now()` at the moment the command is handled, and the resulting event records that timestamp as
the authority.

In tests the `Clock` port is swapped for a frozen clock, which is how we assert ladder behaviour at
exact boundaries (47h59m vs 48h01m) deterministically instead of hoping.

---

## 6. Idempotency

Every money-moving tool accepts an `idempotency_key`. We store `(key → response)` and replay the
stored response on a repeat, rather than re-executing.

This is not defensive politeness. Agents retry on timeout by default, and a timeout is
indistinguishable from a failure to the caller. Without this, a network blip during
`confirm_with_deposit` produces two deposits and two authorisations against one customer. The brief calls
this out explicitly in §6.3.

---

## 7. The failure path, end to end

This is the B5 deliverable and it deserves its own trace. From brief §6.4: the merchant declines an
already-confirmed, already-paid slot because the practitioner called in sick.

```
   Merchant clicks "Decline" ─────────────────────────────┐
                                                          ▼
                                        ┌─────────────────────────────────┐
                                        │ MerchantDeclineCommand          │
                                        └────────────────┬────────────────┘
                                                         ▼
                                        ┌─────────────────────────────────┐
                                        │ DOMAIN CORE decides:            │
                                        │  cause = MERCHANT               │
                                        │  ⇒ ladder does NOT apply        │
                                        │  ⇒ full refund, authorisation released │
                                        └────────────────┬────────────────┘
                                                         ▼
              emits, atomically, as one transaction:
              ┌───────────────────────────────────────────────────────────┐
              │ MERCHANT_DECLINED   reason=practitioner_unavailable        │
              │ SLOT_RELEASED       slot returns to inventory              │
              │ REFUND_ISSUED       ₹300 → original instrument             │
              │ AUTHORIZATION_RELEASED  left to lapse, never captured             │
              │ ALTERNATIVES_OFFERED 3 slots matching original constraints │
              └───────────────────────────────────────────────────────────┘
                                                         ▼
                       pushed back to the originating agent, structured
```

**Why this failure and not a staged network error.** A network error is a failure *of the
implementation*. A merchant decline is a failure *of the domain* — property #7 in brief §2.3, one that
goods commerce has no flow for at all. Choosing it means the failure handling is a feature we had to
build regardless, not a demo prop. That reads very differently to a judge.

The critical correctness detail: **cause attribution**. The cancellation ladder exists to price
*customer*-initiated cancellations. A merchant-initiated cancellation must not touch it. Getting this
wrong — charging a customer a penalty because the doctor was ill — is the single most damaging bug
this system could have, so cause is an explicit, required field on the cancel command rather than
something inferred.

---

## 8. What runs in the background

Four things happen without anyone calling a tool:

| Job | Trigger | Action |
|---|---|---|
| Hold expiry | TTL elapsed | Append `HOLD_EXPIRED`, release slot |
| No-show window | Appointment start elapsed + grace | Append `NO_SHOW_ELIGIBLE` — **does not charge** |
| Authorisation lapse | 5-day `manual_expiry_period` passed | Append `AUTHORIZATION_LAPSED` — records that authority was lost |
| Reconciliation | Every tick, over open (CONFIRMED) bookings | Diffs the trail against Razorpay's own record via `PaymentProvider.fetchPaymentStatus`/`PaymentRail.fetchAuthorizationStatus`; appends `RECONCILIATION_MISMATCH` on disagreement |

Note the second carefully. Elapsed time makes a booking *eligible* for a no-show charge. It does not
execute one. The charge still requires the merchant to affirmatively mark non-attendance. Time alone
never moves money — that would be a money action firing on inference, which B4 forbids.

**The reconciliation worker exists to close a gap the original design left open** (dev-logs/014, from a
code review): Idea 1 says the trail *is* the truth, but that was only ever proven internally consistent
— every money-moving command handler appends its own event as part of the same transaction that made
the money move, real, and provable against Postgres. What it never proved is that Razorpay's own record
still agrees with that trail *later* — if Latch's server crashed between a capture actually succeeding
at Razorpay and the local transaction that appends `DEPOSIT_CAPTURED`, nothing would ever notice. The
reconciliation worker (`src/app/reconciliation-worker.ts`) is the periodic, poll-based half of the fix:
it asks Razorpay directly, on every tick, whether the trail's claims about a `CONFIRMED` booking's
deposit and authorisation still hold. `POST /webhooks/razorpay`
(`src/adapters/merchant-api/server.ts`, §12 below) is the real-time half of the same fix, triggered by
Razorpay's own webhook delivery rather than a poll — both funnel into the same
`RECONCILIATION_MISMATCH` event and the same append path (`src/app/reconciliation.ts`), reusing the
existing `PaymentProvider`/`PaymentRail` ports rather than inventing a new outbound integration. This is
what upgrades "the trail is the truth" from an internally consistent claim to an externally verified
one.

---

## 9. Trust model — who can do what

| Actor | Can | Cannot |
|---|---|---|
| Third-party agent | Search, read policy, hold, confirm, reschedule, cancel, call `charge_no_show` (gated — see below) | Set policy, decline, mark non-attendance, exceed authorisation ceiling, assert a timestamp |
| Merchant | Set policy, decline, mark non-attendance | Debit above the registered authorisation ceiling |
| Latch server | Orchestrate all of the above | Debit above the registered authorisation ceiling |
| Razorpay | Enforce the ceiling | — |

The last two rows are the interesting ones: **Latch is not fully trusted by its own design.** The
authorisation ceiling constrains us as much as it constrains the agent.

---

## 10. Deliberate non-goals

Named here so they read as decisions rather than gaps. Full treatment in
`04-features-and-limitations.md`.

- **Not a calendar product.** We model slots minimally. Real merchants have a scheduler; the thesis is
  that the calendar and the money must be *one object to an agent*, not that we should rebuild Calendly.
- **Not multi-tenant.** One merchant, one Razorpay account. Multi-tenancy is engineering volume, not
  architectural insight, and it would consume the entire timeline.
- **Not an AI receptionist.** The arrow points the other way (brief §3, Layer 3). Latch never talks to
  a human on the phone. It makes the merchant reachable by everybody else's agents.
- **No agent identity verification.** That layer is occupied — Web Bot Auth, Visa TAP, NPCI UAP
  (brief Appendix A). We assume an authenticated agent and compose with those rather than reinvent.

---

## 11. Webhooks — verified, not trusted blindly

`POST /webhooks/razorpay` (`src/adapters/merchant-api/server.ts`) is Latch's one inbound surface that
is neither an agent tool nor a merchant action — the caller is Razorpay's own infrastructure. That makes
it a different kind of trust boundary from everything else in §9's table, so it gets its own section
rather than being folded into the merchant API's write-up.

**Every delivery is signature-verified before anything else happens.** Razorpay signs the raw request
body with HMAC-SHA256 against a webhook secret, sent as `X-Razorpay-Signature`
(`src/adapters/payment/razorpay-shared.ts`'s `verifyRazorpayWebhookSignature`, compared with
`timingSafeEqual`). An unsigned or wrongly-signed request is rejected with `400` before the payload is
even parsed as a Razorpay event — dev-logs/014's own framing of the risk: an endpoint that appends trail
events on request, without verifying who sent them, is a real attack surface in a money system, strictly
worse than the gap it closes, if built carelessly.

**What a verified delivery is actually allowed to do is narrow.** It never appends `DEPOSIT_CAPTURED`,
`AUTHORIZATION_HELD`, or any other money event directly — that would mean reconstructing a gate/bound/
authority quad from a webhook payload alone, outside the domain core's own decision path, which is
exactly the kind of unaccountable money movement Idea 2 exists to make impossible. The only thing a
webhook can ever cause is a `RECONCILIATION_MISMATCH` — a *report* that Razorpay's own record disagrees
with the trail, via the same `reconcileObservedPayment`/`appendReconciliationFindings` path §8's
reconciliation worker uses (`src/app/reconciliation.ts`). Resolving a real mismatch, if one is ever
found, is a human/merchant action outside this system's automated authority — the same posture as every
`Nothing`-response refusal in `03-domain-model.md` §5.

**Idempotent by Razorpay's own event identity, not by trusting a single delivery.** Razorpay retries a
webhook on anything but a `2xx`, so a redelivery is expected, not exceptional. The handler claims
`(scope: 'razorpay_webhook', key: '{event}:{entityId}')` via the same `IdempotencyStore.claim`/`put`/
`release` primitive dev-logs/013 added for money-moving commands, and replays the stored outcome on a
repeat rather than re-processing.

---

## 12. Inventory-denial — hold-spam and the rate ceiling

Gap named in dev-logs/014's code review: `04-features-and-limitations.md`'s existing "no agent identity
verification" answer covers *identity*, not *abuse rate*, and the two are separate questions.
`hold_slot` moves no money by design (§3, §4 above) — that is exactly what makes it cheap to abuse. A
hostile agent sitting at `max_concurrent_holds_per_agent` and re-holding as fast as each TTL lapses can
lock a merchant's calendar against legitimate agents indefinitely, and because no money ever moves,
**it leaves zero payment trail** — the failure mode B3/B5 are built to make visible doesn't apply here at
all, because nothing about it looks like a money bound being tested.

**The fix is a second, independent bound: a request-rate ceiling, not just a concurrent-count ceiling.**
`Policy.holdRateLimitPerMinute` (`src/domain/policy.ts`) caps how many `HOLD_CREATED` events one agent
may accumulate in a rolling 60-second window, regardless of how many of those holds are still live —
release-and-re-hold no longer resets the clock the way it resets `max_concurrent_holds_per_agent`.
Checked inside the exact same `lockAgent` advisory-lock transaction `hold_slot` already opens for the
concurrent-hold check (`src/app/hold-slot.ts`), so the two bounds are enforced atomically against one
serialised window per agent — no new race to close. A breach is refused with the new `RATE_LIMITED` code
and recorded as `ACTION_REFUSED`, same as every other bound in this system: an attempted breach is a
permanent, demonstrable event, not a silent 429.

This was a genuine judgement call between building the ceiling for real and naming it as a documented,
deliberately-unmitigated risk (the review's own explicit guidance — see dev-logs/014 for the reasoning
recorded at the time). The ceiling was built: the query it needs (count of `HOLD_CREATED` events for an
agent since a timestamp) was cheap against the existing schema, and it closes the gap rather than merely
describing it.
