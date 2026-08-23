# Slice 5 — Cancel, reschedule, background worker

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Latch exposes an Indian dermatology clinic to any third-party AI agent over MCP. Razorpay AI
Buildathon 2026, Track 01.

**Slices 0–4 are complete**: event store, ladder evaluator, MCP tools, real deposits, the
merchant-decline failure path, authorisations, and `charge_no_show`.

This slice completes the tool surface — all seven tools working — and adds the background jobs.

## Read before writing any code

- `docs/03-domain-model.md` §2 (ladder), §3 (state machine, especially the reschedule note), §5
- `docs/01-architecture.md` §8 (background jobs), §5 (server clock)
- `docs/02-tech-stack.md` §9 (why no Redis)
- **The most recent `dev-logs/` entry**

## Build this

**1. `cancel` with the ladder applied — `cause=CUSTOMER`**

Slice 3 built the merchant-caused path. This is the customer-caused one, where the ladder *does* apply.

- Tier computed from `clock.now()` at the moment the command is handled. **Never from an agent-supplied
  timestamp.** An agent may claim it is calling at 2pm; we do not care.
- `RETENTION_APPLIED` and `REFUND_ISSUED` split the deposit. Floor on retention, remainder on refund,
  so they sum to exactly the deposit.
- Authorisation released — a cancelled booking must leave no live no-show authority.

**2. `reschedule` — a self-transition, not a cancel-and-rebook**

`CONFIRMED → CONFIRMED`. Same `booking_id`, same deposit, same authorisation, new `starts_at`.

Do **not** implement this as cancel-then-rebook. That would:
- refund the deposit and lose ₹7.08 of unrecoverable MDR (`docs/05-cost-model.md`)
- void and re-register the authorisation
- break the trail's narrative — the history should read as one booking that *moved*, because that is
  what happened

This is `agentic-services-transactability-brief.md` §2.3 property #6 taken literally: *"Not return, not
refund — a move."* It is also the single most common post-booking action in the appointment economy and
has no event type in UCP at all, which is part of the novelty claim.

**The gate is a conjunction:** target slot free **AND** the ladder permits a move at the current
time-to-appointment. Otherwise `LADDER_FORBIDS_MOVE`.

**Test the dodge explicitly:** a customer inside the 100% retention tier must not be able to reschedule
into next month and then cancel for free from there. The ladder is evaluated at the moment of the
reschedule request, against the **original** appointment time.

**3. Background worker — in-process, no Redis**

Two jobs, both low-frequency and idempotent. Claim rows with `FOR UPDATE SKIP LOCKED`:

- **Hold expiry** — TTL elapsed → append `HOLD_EXPIRED`, release the slot
- **No-show eligibility** — start + grace elapsed → append `NO_SHOW_ELIGIBLE`.
  **This does not charge anything.** It only makes a charge permissible. See
  `docs/03-domain-model.md` §3 Rule 3.

**4. Race 2 — hold expiry vs. confirm**

Documented in `docs/03-domain-model.md` §7. The worker may decide a hold has expired at the same
moment `confirm_with_deposit` decides it is still live. Money could be captured against a released
slot.

Take `SELECT … FOR UPDATE` on the booking row in **both** paths. The confirm path must re-read the TTL
**inside** the lock, never before it.

> The general principle: when correctness depends on a check and an action being one thing, they must
> be inside a database transaction, not adjacent lines of TypeScript.

## Done when

- All seven MCP tools work
- Ladder tests: cancelling at 72h refunds fully, at 47h59m retains 50%, at 11h59m retains 100%
- A frozen-clock test proves an agent cannot influence the tier by claiming a different time
- Reschedule preserves `booking_id`, deposit, and authorisation — assert the authorisation is unchanged
- The reschedule-then-cancel dodge is refused
- Holds expire automatically and the slot becomes bookable
- `NO_SHOW_ELIGIBLE` fires on time and charges nothing
- A race test: worker expiry and confirm fired concurrently produce exactly one coherent outcome, and
  no money is captured against a released slot

## Out of scope

The SSE viewer (Slice 6), deployment (Slice 7), hardening tests (Slice 8).

## Before you finish

Write the next `dev-logs/` entry.
