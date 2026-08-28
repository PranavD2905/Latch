# Dev Log 021 — observability, phase 5: idempotency store cleanup

**Date:** 28 August 2026
**Phase:** Fifth item in the stated priority order (dev-logs/017): Pino logging → Prometheus metrics →
error context → circuit breaker → **idempotency cleanup** → graceful shutdown.
**Status:** Built and tested. `npm test`: 216/216 passing (4 new tests in
`idempotency-cleanup-worker.integration.test.ts`, run against real Postgres). `npx tsc --noEmit` clean.
Migration `0014` applied to the local test database.

---

## What the spec asked for vs. what was actually built

The spec's ask (add `expiresAt`/`status` columns, a TTL) turned out to be more schema than the problem
needed: `idempotencyKeys.createdAt` already exists and already records exactly the timestamp a TTL would
be measured from. No new column, no new migration for schema — the only migration this phase needed
(`0014_idempotency_keys_created_at_index.sql`) indexes that existing column for the GC query, not adds a
new one.

## The real gap wasn't just "rows grow forever"

The cross-session brief's own caveat said to read `claim`'s doc comment before restructuring, because "a
naive TTL rewrite could reopen [a] race." Reading it surfaced something more concrete than unbounded
growth: **a process crash between `claim()` succeeding and `put()`/`release()` ever running leaves that
idempotency key permanently stuck.** Nothing else is allowed to call `release` on someone else's claim
(the port's own doc comment is explicit about this), so a pending row with no one left to finish it just
sits there forever — every future retry with that exact key polls out to `timed_out` and returns
`IDEMPOTENT_REPLAY`, indefinitely. A customer's booking attempt could be permanently wedged behind one
unlucky server restart. This is arguably the more important half of "idempotency cleanup," not merely a
storage-growth nicety.

## `IdempotencyStore.deleteExpired(now, { pendingMaxAgeMs, completedGraceMs })`

Two independent thresholds, not one TTL, because a completed row and a pending row decay for different
reasons and at very different safe timescales:

- **Completed** rows (hold a real response) — `completedGraceMs`, set to **7 days**. Nobody retries a
  request from a week ago expecting a replay; a genuinely-late retry past this window just re-executes,
  which is the exact behaviour this key had before idempotency protection existed for it at all.
- **Pending** rows (a claim with no one left to finish it) — `pendingMaxAgeMs`, set to **1 hour**. This
  number is load-bearing, not arbitrary: it must stay well above the longest legitimate claim duration
  anywhere in this codebase, or GC would delete a row a still-*live* claimant owns, and a second caller
  would then successfully re-claim the same key and run concurrently with the first — reopening
  dev-logs/013's exact race (two concurrent identical requests both pass the gate, both append money
  events). The longest real claim duration today is `confirm_with_deposit`'s own 5-minute
  `IDEMPOTENCY_CLAIM_TIMEOUT_MS`; 1 hour is a >10x margin, not a guess. Both constants live in
  `src/app/idempotency-cleanup-worker.ts`, with this reasoning attached directly to them, not buried in a
  commit message.

Implemented as two separate `DELETE`s in `PostgresIdempotencyStore` (one file, `raw jsonb @>` containment
against the same `PENDING_MARKER` shape `claim`/`isPending` already use, to tell a pending row from a
completed one) rather than one query with an `OR` — Drizzle has no typed condition for "is/isn't this JSON
shape," so the raw containment check is the natural way to ask it twice cleanly.

## `runIdempotencyCleanupWorker` — folded into the existing tick, not a new interval

Same shape as `hold-expiry-worker.ts`/`no-show-eligibility-worker.ts`: one function, called from the same
`withGlobalLock`-guarded background tick every process already runs (`mcp/http.ts`'s in-process copy,
`worker/background.ts`'s standalone one) — no new `setInterval`, no new env var for its own cadence. Cheap
on a normal tick: the two `DELETE`s are indexed and return zero rows almost every time.

## One pre-existing inconsistency, named rather than fixed

`claim`/`put` stamp `createdAt` from the real wall clock (`new Date()`), not the injected `Clock` port —
the one place in this store that doesn't follow docs/01-architecture.md §5's "the server clock is the only
clock" discipline the rest of the codebase holds to. Fixing it would mean widening `IdempotencyStore.claim`/
`put`'s signatures to accept a `now: Date`, touching every call site across `src/app/*.ts` that claims an
idempotency key — a much bigger, unrelated refactor than this phase's actual scope. Named here instead of
silently worked around: the new integration test backdates rows directly via a raw `UPDATE` against
`idempotencyKeys` (the same "reach into the table directly for fixture setup" pattern other integration
tests already use for `bookings`/`events`), rather than pretending `FrozenClock` controls row ages it
doesn't actually control.
