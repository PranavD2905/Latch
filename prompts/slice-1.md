# Slice 1 — Happy path, no real money

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Latch exposes an Indian dermatology clinic to any third-party AI agent over MCP, with appointment
money semantics — holds, deposits, cancellation ladders, no-show charges — as the product. Razorpay AI
Buildathon 2026, Track 01.

**Slice 0 is complete**: event store, `Paise` type, `Clock` port, Drizzle schema with the partial
unique index, event types with four mandatory fields, and the fold.

## Read before writing any code

- `docs/03-domain-model.md` — §2 (policy + ladder evaluator), §3 (state machine), §5 (refusal codes)
- `docs/01-architecture.md` §3 (tool table), §5 (server clock), §6 (idempotency)
- `docs/06-build-sequence.md` — find "Slice 1"
- **The most recent file in `dev-logs/`** — it tells you what actually happened in Slice 0, which may
  differ from what was planned

## Settled decisions — do not re-open these

- Event-sourced. Never `UPDATE` a booking's state; append an event and rebuild the projection in the
  same transaction.
- Money is branded integer paise.
- The domain core imports nothing from MCP, HTTP, Razorpay, the DB, or the system clock.
- Time comes only from the `Clock` port.
- **`hold_slot` moves no money.** This is not an oversight to fix — it is the core design decision
  (`docs/01-architecture.md` §3). All risk lives in the cheap reversible phase.

## Build this

**1. The cancellation ladder evaluator** — the only genuinely subtle logic in the system.

Specified exactly in `docs/03-domain-model.md` §2. Two details that are easy to get wrong:

- **Boundaries are inclusive on the upper side.** At exactly 48 hours the customer gets the *better*
  tier. Ambiguity in a penalty schedule resolves in favour of the person being penalised.
- **`retain = floor(deposit * pct / 100)`, refund is the remainder.** Floor, not round, so the two
  halves always sum to exactly the deposit. Rounding must never manufacture money.

**2. Four MCP tools** (Zod schemas, since MCP's TS SDK takes Zod directly)

- `find_slots` — computed live from practitioner working hours minus live bookings.
  **There is no slots table** and you must not create one; see `docs/03-domain-model.md` §1.
- `get_policy` — returns the versioned ladder machine-readably. The agent must be able to tell its
  user "cancel before Thursday 3pm or you're charged ₹400" without a human explaining it.
- `hold_slot` — TTL from policy, idempotency-keyed, concurrent-hold limit per agent. No money.
- `confirm_with_deposit` — against a **fake** payment provider this slice.

**3. `FakePaymentProvider`** implementing the `PaymentProvider` port. It must be able to simulate
success, decline, timeout, and (for Slice 4) a mandate ceiling rejection. Some of those are hard to
trigger reliably against a live sandbox but must be proven to work.

**4. Gates, enforced server-side**
- `confirm_with_deposit` requires a **live unexpired hold** AND **policy acknowledged**
- Policy version is checked at confirm time — if the merchant published a new ladder between the
  agent's read and its confirm, refuse with `POLICY_VERSION_STALE`
- Every refusal uses a code from `docs/03-domain-model.md` §5 and appends an `ACTION_REFUSED` event.
  **Refusals are events.** That is what lets the demo show bounds working rather than assert they exist.

**5. MCP server over stdio**, so you can connect from Claude Code locally and drive it by hand.
Streamable HTTP comes in Slice 7 — stdio is fine for now.

## Why fake payments before real ones

This proves the state machine is correct before any network variable exists. When Razorpay is wired in
next slice and something breaks, the domain is already known-good and you know where to look.

## Done when

- A real agent, over MCP, completes `find_slots → get_policy → hold_slot → confirm_with_deposit`
- **Ladder boundary tests pass on a frozen clock** — at minimum: 72h, exactly 48h, 47h59m, exactly 12h,
  11h59m, and a past-dated appointment. These are the tests that matter most in the whole project.
- A rounding test: 50% of an odd-paise deposit retains and refunds amounts that sum exactly to it
- Confirming without acknowledging policy is refused with `POLICY_NOT_ACKNOWLEDGED`
- Confirming on an expired hold is refused with `HOLD_EXPIRED`
- Exceeding the concurrent-hold limit is refused with `HOLD_LIMIT_REACHED`
- Every refusal above appears in the event log

## Out of scope — do not build

Real Razorpay calls, `cancel`, `reschedule`, `charge_no_show`, mandates, background workers, the SSE
viewer, deployment.

## Before you finish

Write the next `dev-logs/` entry: what you built, what surprised you, decisions the docs did not
settle. If the ladder specification turned out to be ambiguous anywhere, **fix the doc**, not just the
code.
