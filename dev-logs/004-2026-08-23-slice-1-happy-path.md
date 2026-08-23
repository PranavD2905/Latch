# Dev Log 004 — Slice 1: happy path, no real money

**Date:** 23 August 2026
**Phase:** Slice 1 (`prompts/slice-1.md`)
**Status:** Done — all "Done when" acceptance criteria pass under `npm test` (58 tests)

---

## What was built

- **Ladder evaluator** (`src/domain/ladder.ts`) — `evaluateLadder(ladder, appointmentStart, now)`,
  pure. Boundary tests on `FrozenClock` (`src/domain/ladder.test.ts`) at 72h, exactly 48h, 47h59m,
  exactly 12h, 11h59m, and a past-dated (already-started) appointment — plus a rounding test that
  every odd-paise deposit from 1 to 999 splits into retained+refunded halves summing exactly to the
  deposit. **Found and fixed a real bug in the doc's own algorithm** — see "Docs updated" below.
- **Slot computation** (`src/domain/slots.ts`) — `computeSlots()`, pure: working hours (IST,
  hand-rolled fixed-offset math, no library) minus service duration minus supplied busy intervals
  minus anything before `from`. No slots table, per `docs/03-domain-model.md` §1.
- **Refusal vocabulary** (`src/domain/refusals.ts`) — the 10 codes from `docs/03-domain-model.md` §5
  as a const union, plus a `Refusal` error class command handlers throw.
- **Policy type** (`src/domain/policy.ts`) — mirrors the JSON shape in `docs/03-domain-model.md` §2.
- **Ports** (`src/ports/`): `PaymentProvider` (`captureDeposit`, plus decline/timeout/mandate-ceiling
  error types), `EventStore` (transactional — see "the transaction boundary" below), `CatalogRepo`
  (practitioner/service/policy reads), `IdempotencyStore`.
- **Adapters** (`src/adapters/`): `FakePaymentProvider` (scenario-per-idempotency-key: success,
  decline, timeout, `mandate_ceiling_exceeded`); `PostgresEventStore`, `PostgresCatalogRepo`,
  `PostgresIdempotencyStore`; a demo seed script (`db:seed`) — clinic, Dr. Rao, one service, policy v1
  matching the docs' worked example exactly (₹300 deposit, 48/12/0 ladder, ₹400 no-show, ₹1,500
  ceiling).
- **App layer** (`src/app/`) — the four command handlers: `find-slots.ts`, `get-policy.ts`,
  `hold-slot.ts`, `confirm-with-deposit.ts`, plus `refusal.ts` (shared helper for appending
  `ACTION_REFUSED` — see below) and `types.ts` (`AppDeps`, the injected-ports bundle). Depends only
  on `src/domain/` and `src/ports/` — verified by grep, no adapter/MCP/Drizzle/Zod import anywhere
  under `src/app/`.
- **MCP server** (`src/adapters/mcp/`): `server.ts` (`createServer(deps)` — the four tools as Zod
  schemas, transport-agnostic) and `stdio.ts` (the actual entrypoint: real Postgres + `FakePaymentProvider`
  + `SystemClock`, over `StdioServerTransport`). `npm run mcp:dev` runs it.
- Two migrations: `agent_id`/`hold_expires_at` added to `bookings`, and a new `idempotency_keys`
  table (`scope`, `key`, `response`, unique on `(scope, key)`).

## Test coverage — the "Done when" acceptance criteria

1. **A real agent, over MCP, completes the full flow.** `src/adapters/mcp/mcp-e2e.integration.test.ts`
   spawns the actual `stdio.ts` entrypoint as a subprocess via `tsx` and drives it with the real
   `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` — nothing calls the app-layer
   handlers directly. `find_slots -> get_policy -> hold_slot -> confirm_with_deposit` all pass through
   real JSON-RPC over real stdin/stdout.
2. **Ladder boundary tests on a frozen clock** — all six required points, plus indifference to tier
   ordering and an empty-ladder rejection. `src/domain/ladder.test.ts`.
3. **Rounding test** — every odd paise amount 1–999 at 50% sums exactly. Same file.
4. **`POLICY_NOT_ACKNOWLEDGED`, `HOLD_EXPIRED`, `HOLD_LIMIT_REACHED`** — each refused, and each
   refusal verified present in the `events` table (not just that the call threw).
   `src/app/booking-flow.integration.test.ts`, against real Postgres + `FrozenClock`.
5. Two more refusals proven for free, since the machinery already existed: `SLOT_TAKEN`
   (sequential) and — see below — a genuine concurrency test for `HOLD_LIMIT_REACHED`.

`npm test` (58 tests, `tsc --noEmit && vitest run`) passes clean.

## A real concurrency guarantee, not just a claim

`docs/01-architecture.md` §1's bounds table claims concurrent-holds-per-agent is enforced by
"Latch **+ DB constraint**" — the same "impossible, not merely caught" tier as the slot-uniqueness
partial index, and one of the three rows the doc calls out as the ones that actually matter for B3.

A naive implementation (read the count, then insert if under the limit) does **not** deliver that: two
concurrent `hold_slot` calls from the same agent can both read a count under the limit before either
one inserts. I noticed this while implementing the gate and decided it was worth closing properly
rather than shipping the weaker version with a comment promising to fix it in Slice 8 — this
particular bound is one of the three the docs put weight on.

Fix: `EventStoreTx.lockAgent(agentId)` — a Postgres `pg_advisory_xact_lock(hashtext(agentId))`, held
for the transaction's lifetime, taken *before* the count check. It serializes every `hold_slot` call
from the same agent through the same transaction, so the count-then-insert sequence can no longer
race with itself. Verified with an actual race, not just an assertion that the mechanism exists:
`booking-flow.integration.test.ts`'s last test fires 5 concurrent `hold_slot` calls from one agent
against a 3-hold limit via `Promise.allSettled`, and asserts exactly 3 succeed, exactly 2 are refused
`HOLD_LIMIT_REACHED`, and the DB's own count agrees. This moved `hold_slot`'s whole flow (lock, count
check, insert-or-refuse) into a single transaction — previously the count check ran before opening one.

## The transaction boundary around `confirm_with_deposit`

Not fully specified by the docs, so I made a call worth recording. `docs/03-domain-model.md` §7 is
explicit that the hold-liveness check needs `SELECT ... FOR UPDATE`, re-read inside the lock. It does
not say what happens to that lock across the actual payment call. I decided: **never hold a DB row
lock across a network call.**

So `confirm_with_deposit` runs in two transactions:

1. One transaction: `loadSnapshotForUpdate` (the row lock), evaluate every gate (hold liveness, policy
   acknowledged, policy version staleness) against data read under that lock. A failing gate appends
   `ACTION_REFUSED` *and returns an outcome value* — it does not throw inside the callback, because
   throwing would roll back the very event we're trying to keep. The outer function inspects the
   returned outcome after the transaction has committed, and throws `Refusal` then.
2. Outside any lock: call `paymentProvider.captureDeposit(...)`.
3. A second, fresh transaction: on success, append `POLICY_ACKNOWLEDGED` + `DEPOSIT_CAPTURED` +
   `BOOKING_CONFIRMED` and flip the projection to `CONFIRMED`.

A decline or timeout between steps 2 and 3 leaves the booking `HELD` with no event recorded — no
`ACTION_REFUSED`, because a payment decline is an external failure, not a gate/bound refusal, and the
idempotency key is only stored on success, so the agent can simply retry. This does leave a narrow
window (between the two transactions) where a genuinely concurrent duplicate confirm — without an
idempotency key, or with a badly-behaved caller — could theoretically double-capture. I judged that
acceptable for this slice: `docs/06-build-sequence.md` schedules "duplicate money calls under
concurrent retry" as a named Slice 8 hardening test, so this is squarely in-scope for that slice, not
a silent gap I'm hiding now. Flagging it here so Slice 8 knows exactly where to look.

## A bookingId can exist in the event log with no `bookings` row

`ACTION_REFUSED` events for `SLOT_TAKEN` and `HOLD_LIMIT_REACHED` happen before any live booking
exists (a lost race, or a bound hit before the attempted hold could be written). There's no existing
`bookingId` to attach the refusal to, and "refusals are events too" (`docs/03-domain-model.md` §4 ★★)
means the refusal still has to land in the log. Resolution: `EventStore.append` takes
`projection: BookingSnapshot | undefined` — `undefined` means "this event is real, but no
`bookings` row exists or ever will for this bookingId." A fresh, ephemeral bookingId is minted just
for the refusal event to attach to (`src/app/refusal.ts`'s `refuseStandalone`). This is not a
projection-lags-behind-events bug; it's a deliberate case the `EventStore` port's type signature makes
explicit rather than papering over with a placeholder row.

## Decisions made that the docs did not settle

- **`confirm_with_deposit` doubles as the policy-acknowledgment step.** The full seven-tool design
  (`docs/01-architecture.md` §3) has no separate `acknowledge_policy` tool, and Slice 1's four tools
  don't add one either — so `confirm_with_deposit` takes `acknowledgedPolicyVersion` as an input and
  appends `POLICY_ACKNOWLEDGED` itself when the gate passes. Not a docs contradiction (the docs never
  claimed a separate tool), just a gap the docs left for the implementer to close.
- **Idempotency store keeps only successful outcomes.** A failed `captureDeposit` (decline/timeout) is
  never written to `idempotency_keys`, so the same key naturally remains retryable. Matches
  `docs/01-architecture.md` §6's stated purpose (surviving a retry-on-timeout) without also caching a
  known failure as if it were a durable outcome.
- **`hold_slot`'s DB-level concurrent-hold bound is a Postgres advisory lock, not a `CHECK` constraint
  or trigger.** A `CHECK` can't count rows; a trigger could, but an advisory lock scoped to the
  transaction is the standard, cheaper pattern for "serialize this logical key across concurrent
  transactions" and needed no schema change. Verified by the concurrency test above, not just asserted.
- **`bookings.agentId` / `bookings.holdExpiresAt`** (Slice 1 migration) exist because the hold-limit and
  hold-liveness gates need to be answerable from the projection without a full event replay per call.
  Not a new domain concept — bookkeeping the projection needs to serve two specific gates cheaply.
- **DB adapter uses `new Date()` for `bookings.createdAt`/`updatedAt`,** not the injected `Clock`. These
  are infra bookkeeping columns, not inputs to any domain decision — `docs/01-architecture.md` §5's
  "every time-dependent *decision*" rule is about `occurredAt` and ladder/TTL math, which do go through
  `Clock` everywhere in this slice. Flagging the distinction since it's easy to conflate.
- **`listLiveIntervals`'s lower-bound query window is widened by 24h** past `from`, to avoid missing a
  live booking that started just before `from` but whose duration extends into the search window.
  `computeSlots` still does the precise overlap check; the widened DB fetch is a correctness margin,
  not the actual filter.

## Docs updated

**`docs/03-domain-model.md` §2 — the ladder algorithm as literally written doesn't handle an
already-started or past-dated appointment, and contradicts its own worked-example table.** The spec
says "return the first tier (descending `hours_before`) where `hoursUntil >= tier.hours_before`." With
the worked-example ladder (48/12/0), an already-started appointment has `hoursUntil = -2.0`, and
`-2 >= 0` is false — so under a strict reading, *no* tier matches. Yet the very next section's worked-
example table lists `hoursUntil = -2.0` as matching the `hours_before: 0` tier at 100% retention. I
found this while writing the boundary tests (`prompts/slice-1.md` explicitly lists "a past-dated
appointment" as one of the required boundary cases, which is what surfaced it). Fixed the doc: the
ladder's last tier (smallest `hours_before`, by convention 0) is a **catch-all** — it matches not just
`hoursUntil >= 0` but everything below that too, since there's no lower tier to hand the case to. This
is what `src/domain/ladder.ts` implements, and it reproduces every row of the table exactly, including
the negative one.

## Test-DB dependency, extended

`npm run db:seed` now needs to have been run once (creates `mer_clinic` / `prac_dr_rao` /
`svc_derm_consult` / policy v1) before `src/app/booking-flow.integration.test.ts` or
`src/adapters/mcp/mcp-e2e.integration.test.ts` will pass — both fail fast with a clear error in
`beforeAll` if the seed is missing, rather than a confusing downstream failure. This is on top of dev-
log 003's existing "migrations must be applied" requirement. Seeding is idempotent
(`onConflictDoNothing` throughout), so re-running it is always safe.

## Carried forward

- **Slice 8 hardening, explicitly**: the narrow double-capture window in `confirm_with_deposit`
  between its two transactions (see above) — `docs/06-build-sequence.md` already schedules exactly
  this test ("duplicate money calls under concurrent retry").
- **Mandate registration is still unbuilt** (Slice 4 scope, correctly out of scope here per
  `prompts/slice-1.md`). `confirm_with_deposit` captures the deposit only; the state diagram's "deposit
  captured **and** mandate registered" pairing for `BOOKING_CONFIRMED` is partially satisfied this
  slice by design, not by oversight.
- Everything in dev-log 003's carry-forward list (mandate registration verification, UPI Autopay
  pricing, changelog re-check before submission) is unchanged.
- **Slice 2** can now build `RazorpayPaymentProvider` against the same `PaymentProvider` port
  `FakePaymentProvider` implements — no changes needed to `confirm-with-deposit.ts` itself, only to
  `stdio.ts`'s wiring.
