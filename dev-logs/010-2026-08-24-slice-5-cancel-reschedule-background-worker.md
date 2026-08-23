# Dev Log 010 — Slice 5: cancel, reschedule, background worker

**Date:** 24 August 2026
**Phase:** Slice 5 (`prompts/slice-5.md`)
**Status:** Done — all "Done when" acceptance criteria pass under `npm test` (119 tests, `tsc --noEmit &&
vitest run`), twice in a row. All seven MCP tools now exist.

---

## What was built

- **`cancel`** (`src/app/cancel-booking.ts`) — the customer-caused counterpart to `decline_booking`'s
  merchant path (dev-logs/008/009). `CancelledByCustomerEvent` has no `cause` field at all (unlike
  `MerchantDeclinedEvent`'s literal `cause: 'MERCHANT'`) — this command is the only caller that can ever
  construct one, so "an agent forged the cause" is a compile-time non-issue the same way dev-log 009's
  `NonAttendanceMarkedEvent.markedBy` trick already established.
  - Ladder tier from `deps.clock.now()` at the moment the command is handled, against the booking's
    *current* `startsAt`, and against the **policy version the booking was confirmed under**
    (`CatalogRepo.getPolicyVersion` — new, see below) rather than the merchant's active policy.
  - `RETENTION_APPLIED`/`REFUND_ISSUED` are only appended when their amount is non-zero — no Razorpay
    refund of ₹0 is ever attempted, and no "retained ₹0" event clutters a fully-refunded trail. The two
    amounts always sum to exactly the deposit (`floorPercentageOf` + `subtractPaise`, same discipline the
    ladder doc already specifies).
  - `AUTHORIZATION_RELEASED` fires unless the authorisation already lapsed (the authorisation-lapse
    worker got there first) — releasing something already gone would be a second, misleading claim in
    the trail. Same "release means never capture, no rail call" discipline as `decline_booking`.
- **`reschedule`** (`src/app/reschedule-booking.ts`) — a self-transition, `CONFIRMED -> CONFIRMED`. Same
  `bookingId`, deposit, and authorisation; only `startsAt` moves, via the pre-existing
  `BookingRescheduledEvent`/`fold()` support (Slice 0 scaffolding — never previously exercised).
  - Gate is a conjunction. **Ladder permits a move**: this session's reading, pinned down explicitly
    because the docs only said "the ladder must permit a move" — only the ladder's 0%-retention tier
    does; any tier that would retain something on a cancellation also forbids a move
    (`LADDER_FORBIDS_MOVE`). This is what closes the dodge structurally: a booking can never reach "next
    month" from inside a retention tier, because the move is refused before the ladder is ever
    re-evaluated against a new date. **Target slot free**: reuses `hold_slot`'s exact mechanism
    (dev-logs/004) — attempt the projection write, translate a unique-violation on
    `one_live_booking_per_slot` into `SLOT_TAKEN`. `docs/03-domain-model.md` §3 updated with the exact
    rule.
  - The unique-violation path needed a variant of `hold_slot`'s `refuseStandalone`: the booking already
    exists here (it isn't ephemeral), so a caught violation opens a *fresh* transaction against the
    *same* `bookingId` to record `ACTION_REFUSED`, rather than an ephemeral one. `isUniqueViolation` was
    extracted out of `hold-slot.ts` into `src/adapters/db/postgres-errors.ts` once a second call site
    needed it.
- **The background worker** (`src/app/hold-expiry-worker.ts`, `src/app/no-show-eligibility-worker.ts`,
  entrypoint `src/adapters/worker/background.ts`, `npm run worker:background:dev`). Two jobs on one
  interval, per `docs/02-tech-stack.md` §9 — distinct from Slice 4's authorisation-lapse worker, which
  stays its own narrower process.
  - Both claim their batch with `SELECT ... FOR UPDATE SKIP LOCKED` in a single transaction
    (`EventStoreTx.claimHeldBookingsWithExpiredHold` / `claimConfirmedBookingsPastStart`, new), then
    append events for every claimed row inside that same transaction — a different (and, for this
    slice, more literal) shape than the Slice 4 authorisation-lapse worker's unlocked list-read followed
    by a per-row `FOR UPDATE` re-check. `prompts/slice-5.md` names `FOR UPDATE SKIP LOCKED` explicitly
    for these two; a row a concurrent `confirm_with_deposit`/`reschedule`/`cancel` is already holding is
    simply absent from the claim this tick, not blocked on.
  - No-show eligibility's claim query is a deliberate superset (`status='confirmed' AND startsAt < now`)
    — grace minutes vary by the booking's own recorded `policyVersion`, so each claimed row is
    re-checked against `startsAt + graceMinutes` under the lock the claim already holds before deciding
    to append.
  - **`NO_SHOW_ELIGIBLE` does not flip the projection's `status` away from `confirmed`.** `charge_no_show`
    re-derives eligibility from the clock directly (dev-logs/009) and gates on `status === 'CONFIRMED'`;
    so do `cancel` and `reschedule` now. A pure `fold()` replay of the event log still computes
    `status: 'NO_SHOW_ELIGIBLE'` per the state diagram — that divergence between the pure domain model
    and the live Postgres projection is deliberate and now documented (`docs/03-domain-model.md` §3).
- **`CatalogRepo.getPolicyVersion(merchantId, version)`** (new port method + `PostgresCatalogRepo`
  implementation) — the first place a historical policy version actually needed re-fetching.
  `docs/03-domain-model.md` §2: "a booking made under ladder v4 must be cancelled under ladder v4, even
  if the merchant has since published v5." Same discipline `BookingSnapshot.authorizationAmountPaise`
  already applies to the no-show fee (dev-logs/009) — `cancel`/`reschedule` cite the booking's own
  `policyVersion`, never the merchant's current active policy.

## Two real bugs caught while building this

**1. The projection's `startsAt` was silently un-updatable.** `PostgresEventStore.appendFor`'s
`onConflictDoUpdate` `set` clause listed every projected column *except* `startsAt` — because every
prior slice only ever wrote it once, at `INSERT` time (a booking's slot never moved before `reschedule`
existed), nothing had exercised the gap. `reschedule`'s very first test caught it immediately: the
projection row updated everything but the slot. Fixed by adding `startsAt: projection.startsAt` to the
update set — a one-line, load-bearing fix, not a design change.

**2. `drizzle-kit generate`'s auto-timestamp can silently lose to a hand-bumped earlier migration's
timestamp — and the runtime migrator gives no error when it does.** Migrations 0004–0006 (Slice
3/4) all carry suspiciously round, evenly-spaced `when` values in `meta/_journal.json`
(`1787545200000`, `+3600000`, `+3600000`) — hand-set at some point, past whatever `drizzle-kit generate`
actually produced from the real clock. This slice's `db:generate` for migration 0007 produced a
genuine `Date.now()`-based `when` (`1787511875826`) that is *numerically smaller* than 0006's. Drizzle's
Postgres migrator (`pg-core/dialect.js`) does not walk the journal by index — it fetches the **single
row with the maximum `created_at`** already recorded, then applies any migration whose `folderMillis` is
greater than that one number. `1787511875826 < 1787552400000`, so migration 0007 was silently skipped —
`npm run db:migrate` printed "migrations applied" and exited 0, no error, no warning. Only caught because
the merchant-API integration tests started throwing `column "no_show_eligible_marked_at" of relation
"bookings" does not exist` — a real Postgres error, not a silent no-op, which is what surfaced it.
Fixed by hand-bumping 0007's `when` to `1787556000000` (one hour past 0006, continuing the existing
hand-bumped sequence) and trimmed the migration to just the one `ADD COLUMN` statement — `drizzle-kit
generate`'s raw output also proposed a pointless `DROP TYPE`/`CREATE TYPE` round-trip on the unchanged
`event_type` enum, which this migration doesn't need. **Flagged forward:** any future slice that runs
`drizzle-kit generate` again must check the new migration's `when` against the *last* entry in
`_journal.json`, not trust the generated value, for as long as this hand-bumped-timestamp lineage
continues.

## A test-infrastructure gap, closed rather than worked around

Vitest's default file parallelism runs every integration-test file concurrently, in separate worker
threads, all against the same real Postgres database — every prior slice avoided the *slot*-uniqueness
version of this (two files racing the same `(practitioner_id, starts_at)` tuple) by giving each suite
its own calendar day, a convention this slice's new suites also follow. A table-wide background-worker
scan isn't scoped by day at all, so that convention doesn't reach it: `background-workers.integration.test.ts`
freezes its clock forward to make its *own* holds look expired, and in doing so also swept up a
just-created, not-yet-confirmed `HELD` booking from `cancel-booking.integration.test.ts` running
concurrently in a different thread — its absolute clock position happened to already be past that
booking's 10-minute TTL from the sweeping file's point of view. First reproduction: `holdAndConfirm`
failed with `HOLD_EXPIRED` on a booking that had been held less than a second earlier. Root-caused to
the race, not a code defect, by checking `lsof`/`docker ps` first to rule out a second Postgres instance
(dev-logs/README's own warning about Postgres.app vs. Docker colliding on port 5432 — ruled out, only
one instance was listening) before looking at test concurrency. Fixed with a new `vitest.config.ts`
(`test.fileParallelism: false`) rather than trying to make the worker's claim query test-scoped, which
would mean a real background worker that isn't actually table-wide in production — correctness over
wall-clock speed, the same call this project already makes for every real-Postgres/real-Razorpay
integration test.

## Decisions made that the docs did not settle

- **Reschedule "permits a move" ⇔ the ladder's current tier retains 0%.** `docs/03-domain-model.md` §3
  updated with the exact rule and the reasoning for why it closes the dodge structurally.
- **`NO_SHOW_ELIGIBLE` is informational-only in the live projection**, never flipping `status` away from
  `confirmed` — documented as a deliberate divergence from a pure `fold()` replay in
  `docs/03-domain-model.md` §3.
- **Reschedule's target-slot conflict reuses the `SLOT_TAKEN` refusal code** (already in the vocabulary,
  docs/03-domain-model.md §5) rather than inventing a new one — the mechanism is identical to
  `hold_slot`'s, so the code should be too.
- **`cancel` skips `AUTHORIZATION_RELEASED` if the authorisation already lapsed** — releasing something
  already gone would be a second, misleading claim in the trail, not a stronger one.
- **No `SLOT_RELEASED`/`ALTERNATIVES_OFFERED` on `cancel`** — both are named in the domain model
  specifically as part of the merchant-decline path (§4's ★ footnote); a customer-initiated cancellation
  doesn't proactively re-book the customer the way a merchant-caused failure does. The partial unique
  index frees the slot regardless of whether a `SLOT_RELEASED` event documents it.

## Test coverage — the "Done when" acceptance criteria

1. **All seven MCP tools work** — `mcp-e2e.integration.test.ts` updated to assert the full
   `['cancel', 'charge_no_show', 'confirm_with_deposit', 'find_slots', 'get_policy', 'hold_slot',
   'reschedule']` surface.
2. **Ladder tests: 72h refunds fully, 47h59m retains 50%, 11h59m retains 100%** —
   `cancel-booking.integration.test.ts`, plus a fourth case (an already-started appointment, negative
   `hoursUntil`, via the catch-all tier — docs/03-domain-model.md §2's own worked table).
3. **A frozen-clock test proves an agent cannot influence the tier by claiming a different time** — same
   file: `CancelBookingCommand` has no time-related field at all (a compile-time guarantee), and a test
   casts through `unknown` to attach a bogus `claimedNow` anyway, asserting it has zero effect on the
   result.
4. **Reschedule preserves `booking_id`, deposit, and authorisation** —
   `reschedule-booking.integration.test.ts` asserts the same `authorizationId`, exactly one
   `DEPOSIT_CAPTURED` and one `AUTHORIZATION_HELD` event before and after.
5. **The reschedule-then-cancel dodge is refused** — same file: reschedule refused
   `LADDER_FORBIDS_MOVE` from inside the 100% tier, then cancelling from that same unmoved position
   retains the full deposit.
6. **Holds expire automatically, slot becomes bookable** — `background-workers.integration.test.ts`.
7. **`NO_SHOW_ELIGIBLE` fires on time and charges nothing** — same file; also asserts `status` stays
   `CONFIRMED`.
8. **Race test: worker expiry vs. confirm, exactly one coherent outcome, no money against a released
   slot** — same file, `Promise.allSettled` firing both concurrently against a hold already past its TTL
   from both paths' point of view; asserts the final status is either `EXPIRED` (confirm refused
   `HOLD_EXPIRED`, no `DEPOSIT_CAPTURED`) or `CONFIRMED` (worker found nothing to expire, deposit
   genuinely captured) — never an inconsistent mix.

`npm test` (119 tests) passes clean, twice in a row. One pre-existing failure carried forward unchanged
(see below).

## Carried forward

- **`razorpay-payment-provider.live.integration.test.ts`'s idempotent-replay test times out at its
  5000ms default** — reproduced identically against a clean pre-Slice-5 checkout (`git stash`), so this
  is a pre-existing live-network flake, not a regression this slice introduced. Not investigated further;
  out of this slice's scope.
- **Slice 6** (the SSE live audit trail viewer) is next. Everything else from dev-log 009's carry-forward
  list not touched above is unchanged.
