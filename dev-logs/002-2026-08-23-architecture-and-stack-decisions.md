# Dev Log 002 — Architecture and stack decisions

**Date:** 23 August 2026
**Phase:** Pre-implementation
**Status:** Decided — implementation may begin

---

## Constraints fixed today

| Constraint | Value |
|---|---|
| Deadline | 1–2 weeks (target the 2–4 week quality bar within it) |
| Language | TypeScript / Node 22 |
| Demo surface | Agent chat + live audit trail |
| Vertical | Dermatology clinic |
| Merchant count | One (multi-tenancy is a non-goal) |

**Timeline tension, recorded honestly.** The requested scope is a 2–4 week build; the window is 1–2
weeks. The response is **vertical slicing, not layering** — a working end-to-end path (hold → confirm
→ decline → refund) by roughly day 4, then deepening. Building layer by layer would leave nothing
demonstrable until day 10, and on a fixed deadline that is the failure mode that actually kills
submissions.

---

## Decisions

Full reasoning lives in `docs/01-architecture.md` and `docs/02-tech-stack.md`. This log records *why
each was decided*, and what was rejected.

### D1 — Event sourcing for the domain core

**Decided:** the `events` table is the source of truth. Booking state is a fold over events. Nothing
is ever updated in place.

**Why:** bar clause B5 requires showing the audit trail. If the trail is a log written *beside* the
state, it is a second, weaker copy that can drift — the `UPDATE` can succeed while the log write
fails. Making it the source of truth means the system cannot move money without appending an event,
because appending the event *is* the money moving.

**Rejected:** conventional mutable `bookings.status` + a separate log table. Simpler, and it would
have worked. Rejected because it makes the central deliverable a derivative artifact.

**Cost accepted:** more code up front, and reads require folding. Mitigated by keeping it simple —
append-only table plus derived projections in the same database. No CQRS, no event bus, no Kafka.

### D2 — Ports and adapters (hexagonal)

**Decided:** the domain core is pure. No HTTP, MCP, Razorpay, database, or clock types cross into it.
Everything reaches it through interfaces.

**Why, technically:** ladder boundary correctness must be tested deterministically. Asserting that
cancelling at 47h59m retains exactly ₹400 requires a frozen clock, which requires the clock to be a
port.

**Why, strategically:** the novelty claim is that this is a *protocol-level* gap. If appointment
semantics were tangled into MCP handlers and Razorpay SDK calls, that claim would be rhetoric. Because
the core is transport- and provider-agnostic, the claim is demonstrable — another inbound adapter
exposes the same domain over UCP or REST. **The architecture is the argument.**

### D3 — Four mandatory fields on every money event

**Decided:** `action` (B1), `gate` (B4), `bound` (B3), `authority` (B2). No constructor exists that
omits them.

**Why:** it converts bar compliance from something we *remember* to do into something the compiler
*enforces*. The resulting claim — "it is not possible to write code in this system that moves money
without explaining itself" — is materially stronger than "we log our money movements well."

**Refinement added during design:** `bound.enforced_by` is an enum with three values of differing
strength — `latch_policy` < `db_constraint` < `razorpay_mandate`. The trail therefore does not merely
assert a bound existed; it names who would have stopped a breach. This is what makes B3's *"impossible,
not merely caught"* legible in the artifact itself.

### D4 — PostgreSQL, with the guarantee in the schema

**Decided:** Postgres, with a partial unique index preventing double-booking:

```sql
CREATE UNIQUE INDEX one_live_booking_per_slot
  ON bookings (practitioner_id, starts_at)
  WHERE status IN ('held', 'confirmed');
```

**Why:** parallel agents racing for one slot is part of the thesis, not an edge case. Application-level
checking (read, see it's free, write) loses that race, and the failure mode is double-booking a real
doctor. A unique index cannot be raced.

**Rejected:** SQLite — no meaningful write concurrency, so the race we need to survive cannot even be
reproduced. MongoDB — transactional guarantees are opt-in, which is the wrong default for money.

### D5 — Drizzle over Prisma

**Decided:** Drizzle ORM.

**Why:** the generated SQL is legible, we can drop to raw SQL for the partial index and `FOR UPDATE`
without leaving the type system, and there is no engine binary or codegen step. Explaining a
money-critical concurrency guarantee to a judge is far easier when the code reads like the SQL it
becomes.

**Rejected:** Prisma. More popular, nicer DSL, but it abstracts SQL away at exactly the point we most
want to show it — and partial unique indexes require raw migration SQL anyway, so we would carry its
weight and still hand-write the important part.

### D6 — Streamable HTTP transport, not stdio

**Decided:** deploy at a public HTTPS endpoint; keep stdio for local iteration only.

**Why:** stdio means the agent spawns the server as a local subprocess. That demos as a script, not as
a merchant reachable over the internet. The claim is that any third-party agent can transact with a
merchant without a partnership — the transport should embody the claim.

### D7 — No message broker, no Redis

**Decided:** background jobs run in-process, claiming rows with `FOR UPDATE SKIP LOCKED`.

**Why:** two low-frequency idempotent jobs (expire holds, mark no-show eligible). BullMQ + Redis would
add a second datastore, a second failure mode, and a second thing to explain in a five-minute video,
for roughly one job per minute.

---

## Economics discovered during design

Two findings from `docs/05-cost-model.md` that changed how confident I am in D-level decisions:

**1. Razorpay does not return the platform fee on refunds.** Verified from Razorpay's own docs. This
means a graceful failure is not a free failure — the merchant-decline path costs the merchant ₹7.08 in
sunk MDR with zero revenue.

This *retroactively validates* the "holds move no money" decision from brief §6.3. Had holds been
implemented as authorisations, every abandoned hold would burn ₹7.08 irrecoverably. An agent exploring
five slots would cost the merchant ₹35 in pure waste. At zero money movement it costs ₹0.

> The architecture was chosen on correctness grounds and turns out to also be the cheap one.

**2. Latch has effectively no COGS.** It runs no model — the inference happens inside the customer's
agent, paid for by the agent's owner. Marginal cost per booking is a few Postgres writes and two
Razorpay calls. This is unusual for something presented as an AI product and worth saying in the pitch.

---

## Carried forward from dev-log 001

- [ ] Verify UPI Autopay mandate registration end-to-end in test mode
- [ ] Determine whether the auth transaction must be ₹1 or can be the deposit itself (decides one
      payment or two at booking, and therefore one fee or two)
- [ ] Obtain UPI Autopay / mandate pricing from Razorpay (listed "on request")
- [ ] Re-verify Razorpay changelog + UCP roadmap immediately before submission (brief §7)

---

## Candidate "failure and recovery" stories for the submission

Razorpay requires a story of a failure and the recovery from it. Recording candidates **as they
happen**, rather than reconstructing something plausible at the end. Reconstructed stories sound
reconstructed.

**Candidate 1 — the Reserve Pay dead end (already happened, dev-log 001).**

The brief's entire money architecture was specified on UPI Reserve Pay. Building on it was the plan.
It has no public API — it is a launch announcement, not a shippable product. The fallback (card
authorise-then-capture) turned out to be worse: Razorpay auto-refunds uncaptured authorisations within
~3 days, and appointments are booked weeks out.

The recovery was not a workaround but an upgrade. UPI Autopay mandates carry a `max_amount` enforced by
Razorpay, which moved the B3 bound *outside our own trust boundary* — strictly stronger than the
server-side ceiling the brief had assumed.

**Strength:** genuine, architectural, and the recovery is better than the original plan. Currently the
strongest candidate.

**Weakness:** happened during research rather than during implementation, so it lacks the drama of a
broken build.

**Candidates to watch for during implementation:** the hold-expiry-vs-confirm race (D-level design
already anticipates it, so it may surface as a real bug), test-mode mandate behaviour diverging from
docs, and idempotency under concurrent retries.
