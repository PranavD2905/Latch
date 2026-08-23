# Latch — Architecture

**Status:** Decided, pre-implementation
**Date:** 23 August 2026
**Companion docs:** `02-tech-stack.md` (what we build it with and why), `03-domain-model.md` (the state
machine in detail), `04-features-and-limitations.md` (honest scope)

---

## 0. The one-paragraph version

Latch is a **service-transaction layer**. It sits on top of a single Indian service merchant's
Razorpay account and exposes that merchant to *any* third-party AI agent as something that can be
transacted with — not merely booked. The agent-facing surface is an MCP server with seven tools. The
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
  authority: AuthorityRef  // B2 — the policy version / mandate id that granted permission
  // ...amount, timestamps, ids
}
```

There is no constructor for a money event that omits them. The consequence:

> **It is not possible to write code in this system that moves money without explaining itself.**

That is a materially different claim from "we log our money movements well," and it is the sentence
worth saying in the pitch video.

### Idea 3 — Bounds are enforced outside our own trust boundary

Covered in full in `dev-logs/001`. In summary:

A no-show charge is a debit against a customer who received nothing. That is the most abusable action
in the entire system, so it gets the strongest possible bound. At booking time we register a **UPI
Autopay mandate** carrying a `max_amount`. Any later debit above that number is rejected by
**Razorpay**, not by us.

| Bound | Value | Enforced by | Can a Latch bug defeat it? |
|---|---|---|---|
| Deposit amount | From merchant policy record | Latch policy engine | Yes, in principle |
| Ladder retention % | From merchant policy record | Latch policy engine | Yes, in principle |
| Concurrent holds per agent | Configured per agent | Latch + DB constraint | No — DB constraint |
| Double-booking a slot | One booking per (practitioner, start) | **Postgres partial unique index** | **No** |
| **No-show debit ceiling** | `max_amount` on the mandate | **Razorpay, at the rail** | **No** |

The bottom three rows are the ones that matter. B3 demands the breach be *"impossible, not merely
caught."* For those three, it genuinely is.

---

## 2. System diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  ANY THIRD-PARTY AGENT                                               │
│  Claude · ChatGPT · a user's personal agent · another merchant's bot │
│  Latch does not know or care which. That is the entire point.        │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  MCP over Streamable HTTP
                             │  (7 tools, Zod-validated)
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
   Orders · Payments · Refunds · UPI Autopay mandates
```

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

---

## 3. The seven tools, and where the risk lives

From brief §6.2, with the enforcement point named for each.

| Tool | Money | Gate (B4) | Bound (B3) | Bound enforced by |
|---|---|---|---|---|
| `find_slots` | none | — | — | — |
| `get_policy` | none | — | — | — |
| `hold_slot` | **none** | Slot free at request time | Max concurrent holds/agent; TTL | DB constraint + Latch |
| `confirm_with_deposit` | deposit capture | Live unexpired hold **and** policy acknowledged | Policy deposit amount; mandate ceiling | Latch + **Razorpay** |
| `reschedule` | price delta only | Target free; ladder permits move now | Delta ≤ original booking value | Latch |
| `cancel` | refund / retention | Booking exists; tier from **server clock** | Retention ≤ ladder tier for true timestamp | Latch |
| `charge_no_show` | debit | Start time elapsed **and** merchant marked non-attendance | Mandate `max_amount` | **Razorpay** |

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
`confirm_with_deposit` produces two deposits and two mandates against one customer. The brief calls
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
                                        │  ⇒ full refund, mandate revoked │
                                        └────────────────┬────────────────┘
                                                         ▼
              emits, atomically, as one transaction:
              ┌───────────────────────────────────────────────────────────┐
              │ MERCHANT_DECLINED   reason=practitioner_unavailable        │
              │ SLOT_RELEASED       slot returns to inventory              │
              │ REFUND_ISSUED       ₹300 → original instrument             │
              │ MANDATE_REVOKED     ceiling returned, no orphan authority  │
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

Two things happen without anyone calling a tool:

| Job | Trigger | Action |
|---|---|---|
| Hold expiry | TTL elapsed | Append `HOLD_EXPIRED`, release slot |
| No-show window | Appointment start elapsed + grace | Append `NO_SHOW_ELIGIBLE` — **does not charge** |

Note the second carefully. Elapsed time makes a booking *eligible* for a no-show charge. It does not
execute one. The charge still requires the merchant to affirmatively mark non-attendance. Time alone
never moves money — that would be a money action firing on inference, which B4 forbids.

---

## 9. Trust model — who can do what

| Actor | Can | Cannot |
|---|---|---|
| Third-party agent | Search, read policy, hold, confirm, reschedule, cancel | Set policy, decline, mark no-show, exceed mandate ceiling, assert a timestamp |
| Merchant | Set policy, decline, mark non-attendance | Debit above the registered mandate ceiling |
| Latch server | Orchestrate all of the above | Debit above the registered mandate ceiling |
| Razorpay | Enforce the ceiling | — |

The last two rows are the interesting ones: **Latch is not fully trusted by its own design.** The
mandate ceiling constrains us as much as it constrains the agent.

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
