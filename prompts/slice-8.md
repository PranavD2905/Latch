# Slice 8 — Hardening

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Latch exposes an Indian dermatology clinic to any third-party AI agent over MCP. Razorpay AI
Buildathon 2026, Track 01.

**Slices 0–7 are complete**: all seven tools, real Razorpay test mode, failure path, authorisations, live
viewer, deployed with a remote agent connecting.

## What this slice is for

Everything works. This slice **proves** it works under the conditions that actually break money
systems — concurrency, retries, and races.

These tests are not hygiene. They are **evidence**. `docs/04-features-and-limitations.md` §3 lists the
concurrency test among the five things that must never be cut, because the claim *"double-booking is
structurally impossible"* is only worth making if it has been demonstrated.

## Read before writing any code

- `docs/01-architecture.md` §4 (concurrency), §6 (idempotency)
- `docs/03-domain-model.md` §5 (refusal codes), §7 (the two races)
- `docs/04-features-and-limitations.md` §3 (never-cut list)
- **The most recent `dev-logs/` entry**

## Build this

**1. ⭐ The concurrency test — one slot, N agents**

Fire `hold_slot` for the same `(practitioner, starts_at)` from many concurrent connections. Assert:
- **exactly one** succeeds
- every loser gets `SLOT_TAKEN`
- exactly one live booking row exists
- the winner's `HOLD_CREATED` is in the log and no loser's is

This must exercise the **partial unique index**, not an application check. To be sure it does: try
temporarily dropping the index locally and confirm the test fails. If it still passes, something is
guarding at the application layer and the architectural claim is false.

**2. The hold-expiry vs confirm race**

Fire the background worker's expiry sweep and `confirm_with_deposit` concurrently on the same booking.
Assert exactly one coherent outcome, and — critically — that **no money was captured against a
released slot.** Check Razorpay, not just our log.

**3. Idempotency under concurrent retry**

Fire the same idempotency key on `confirm_with_deposit` from several connections **simultaneously**
(not sequentially — sequential retry is the easy case). Assert one capture at Razorpay, one authorisation,
one set of events.

Repeat for `charge_no_show` and `cancel`.

**4. Every refusal code exercised**

Walk `docs/03-domain-model.md` §5 and write a test per code:
`SLOT_TAKEN`, `HOLD_EXPIRED`, `HOLD_LIMIT_REACHED`, `POLICY_NOT_ACKNOWLEDGED`,
`POLICY_VERSION_STALE`, `CAPTURE_AMOUNT_MISMATCH`, `LADDER_FORBIDS_MOVE`, `NOT_YET_ELIGIBLE`,
`MERCHANT_ACTION_REQUIRED`, `IDEMPOTENT_REPLAY`.

Each must append an `ACTION_REFUSED` event. Refusals being recorded is what lets the demo *show* bounds
working.

**5. Agent-cannot-escalate tests**

Assert an agent cannot, through any tool path:
- trigger a merchant decline
- mark non-attendance
- change the policy
- influence the ladder tier by supplying a timestamp
- exceed the authorisation ceiling
- exceed its concurrent-hold limit

This is `docs/01-architecture.md` §9 (trust model) turned into executable assertions.

**6. Demo rehearsal**

Run the full video script from `docs/06-build-sequence.md` end to end against the **deployed**
environment. Time it. Fix anything that is slow, flaky, or unclear on screen.

Make the over-ceiling refusal trivially easy to trigger on demand — a seed flag or a script. Fumbling
it live is the worst possible outcome for the strongest moment in the pitch.

## Done when

- Concurrency test passes and provably depends on the DB index
- Both races produce exactly one coherent outcome, with no orphaned money at Razorpay
- Concurrent idempotent retries produce exactly one money movement
- Every refusal code has a test and appears in the trail
- No agent-callable path can escalate privilege
- The full demo runs deployed, inside five minutes, twice in a row without intervention

## Out of scope

New features. If something is missing, check `docs/04-features-and-limitations.md` — it is probably a
declared non-goal. **Do not add features in the hardening slice.**

## Before you finish

Write the next `dev-logs/` entry. Note any bug the concurrency tests caught — a real race found and
fixed here is a **strong candidate for the submission's failure-and-recovery story** (candidates
tracked in `dev-logs/002`).
