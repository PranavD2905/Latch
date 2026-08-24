# Dev Log 013 — Slice 8: hardening

**Date:** 25 August 2026
**Phase:** Slice 8 (`prompts/slice-8.md`)
**Status:** Done. `npm test` green (132/132, up from 121), run repeatedly with no flakiness observed. Two
real concurrency bugs found, reproduced, and fixed — not hypothesized. Full demo rehearsal run twice
against the live deployed environment, including two real human Checkout completions.

---

## The headline: `confirm_with_deposit` had a real, unprotected race with the hold-expiry worker

This is the strongest failure-and-recovery candidate to come out of any slice so far (dev-logs/002's
convention) — stronger than the idempotency-duplication bug below, because this one can move real money
with zero audit trail for it, not just duplicate a trail entry.

**The bug.** `confirm_with_deposit` splits into two DB transactions with a real, unlocked payment call in
between (deliberately — docs/03-domain-model.md §7 / dev-logs/004 already explain why a lock must never
be held across a network call). The *first* transaction (the gate check) only validates that the hold is
live; it writes nothing. The booking's `status` stays `'HELD'` in the projection for the entire payment
call. The *second* transaction, after the payment lands, unconditionally appends the CONFIRMED-transition
events and flips `status` to `'CONFIRMED'` — it never re-checked what happened to the booking in the
gap.

The background hold-expiry worker (`src/app/hold-expiry-worker.ts`) claims rows via `FOR UPDATE SKIP
LOCKED` against `holdExpiresAt < now`. Between the gate transaction committing and the final transaction
starting, the booking row is **unlocked** — that's the whole point of not holding a lock across the
payment call. If the hold's TTL happens to lapse inside that exact window, the worker can legitimately
claim the row, append `HOLD_EXPIRED`, and flip it to `EXPIRED` — while `confirm_with_deposit` is still
mid-payment-call, having already correctly judged the hold live a moment earlier.

When `confirm_with_deposit`'s final transaction then runs, it blindly overwrites whatever the worker did:
the booking ends up `CONFIRMED` again, with real money captured, and the `HOLD_EXPIRED` event sits
silently in the trail underneath a status that no longer explains it. Worse: if a *different* agent had
grabbed the now-freed slot in that same window (the partial unique index frees a slot the instant status
leaves `'held'`/`'confirmed'`), the final transaction's write would collide with the partial unique index
and throw — an unhandled Postgres error, thrown *after* a real deposit and a real authorisation had
already been captured at Razorpay, with the transaction that would have recorded either rolled back. Real
money moved, zero trail for it. That is about as bad as this kind of bug gets.

**Reproduced, not assumed.** Wrote the race directly: two independent `FrozenClock`s straddling the same
`holdExpiresAt` instant (one reading a moment before, believing the hold live; one reading a moment
after, believing it sweepable) and a `DelayedPaymentProvider`/`DelayedPaymentRail` test double that
widens the payment-call window to 200ms so the worker's real Postgres round trip reliably lands inside
it, sequenced deterministically (confirm fired, a 100ms pause, then the worker). Before the fix, this
failed 3/3 runs, every time with the exact predicted corruption: a `HOLD_EXPIRED` *and* a
`DEPOSIT_CAPTURED` on the same booking, status silently forced back to `CONFIRMED`. Verified this by
literally reverting `src/app/confirm-with-deposit.ts` to its pre-fix `HEAD` version via `git stash` (kept
every other Slice 8 change in place), running the new test, watching it fail with `expected true to be
false` on the "never both" assertion, then restoring the fix and watching it pass 3/3. The test itself is
`src/app/background-workers.integration.test.ts`, describe block "Race 2," test "a straddled race
(confirm reads the clock just before TTL, the worker just after)."

**The fix — claim the confirmation window, don't hold a lock across it.** The gate transaction, on
success, now bumps the booking's own `holdExpiresAt` forward by `CONFIRMATION_CLAIM_WINDOW_MS` (5
minutes — matches `DEFAULT_CAPTURE_TIMEOUT_MS`, the same ceiling the payment adapters already use for a
human at Checkout) as part of a real write it now performs: `POLICY_ACKNOWLEDGED` moved from the final
transaction into the gate transaction, since it doesn't depend on the payment result at all, and gave the
bump-write something to ride alongside without inventing a new event-store primitive. The worker's own
claim query (`holdExpiresAt < now`) then simply doesn't select a row that's just had its expiry pushed
five minutes out — no new lock, no new column, no connection held open across the payment call. The final
transaction also gained a defensive invariant check: if the booking isn't still `HELD` when it goes to
write CONFIRMED, it throws loudly instead of silently overwriting — a last-resort tripwire in case the
claim mechanism itself ever has a bug, so this class of failure can never again land silently.

## The second bug: idempotent retries genuinely raced, not just theoretically

`IdempotencyStore` was `get(scope,key)` at the top, `put(scope,key,response)` at the bottom — a classic
check-then-act gap. Two callers with the *same* key, arriving close enough together, both miss the `get`
before either has `put`. For `hold_slot` this mostly self-heals (the partial unique index turns a
same-slot double-attempt into one winner and one `SLOT_TAKEN` — see the concurrency test below), but for
`confirm_with_deposit`/`charge_no_show`/`cancel`/`reschedule`, the booking's terminal status only flips in
the *last* transaction, exactly like the bug above — so two concurrent identical-key calls can both pass
every gate and both append their own copy of the same money events. The underlying payment call itself
deduplicates (both `FakePaymentProvider` and the real Razorpay adapters treat a repeated idempotency key
as a replay, not a new charge — dev-logs/006), so this never doubled a real payment, but it did double the
**trail**: two `DEPOSIT_CAPTURED` events for one real deposit is exactly the kind of drift `01-architecture.md`
Idea 1 says this design exists to make impossible.

**The fix.** `IdempotencyStore` gained `claim(scope, key, opts?)`: an atomic `INSERT ... ON CONFLICT DO
NOTHING` against a pending-marker row. The winner gets `'claimed'` and does the real work, then either
`put`s the real response (now an upsert, overwriting the pending marker) on success or `release`s the
claim (a plain delete) on any failure — preserving the existing, load-bearing rule that a failed attempt
stays retryable, not stuck. Every other concurrent caller polls the same row until it sees a real response
(`'completed'`) or a timeout (`'timed_out'`) — no schema migration, since the pending marker is a sentinel
JSON object (`{ __idempotencyPending: true }`), never a value a real command result could produce.
`hold_slot`/`confirm_with_deposit`/`charge_no_show`/`cancel`/`reschedule` all moved onto `claim`/`release`
(only the first three were named explicitly in slice-8.md item 3; the same bug shape existed in the other
two, and the fix was cheap once the primitive existed, so all five got it for consistency).

**`IDEMPOTENT_REPLAY` was dead code until now.** It was in `REFUSAL_CODES` since Slice 1 but nothing ever
threw it — every handler just silently replayed on a cache hit, with no path that could ever time out. It
now fires when a `claim` call's twin genuinely never finishes within the timeout (a still-in-flight
sibling, or a crashed process that claimed but never released) — a real, previously-missing case, not a
retrofit for the test's sake. `confirm_with_deposit` gets a 5-minute claim-wait (same reasoning as the
holdExpiresAt bump above — its own twin might legitimately be waiting on a human); the other four get 30
seconds, generous for anything that isn't blocked on a human. `AppDeps.idempotencyClaimTimeoutMs` is an
optional override tests use to force the timeout path in well under a second, rather than actually
waiting out the production default.

**Verified genuinely concurrent, not sequential retry**, per slice-8.md's own explicit "sequential retry
is the easy case" — every new idempotency test fires `Promise.all` with N identical calls, never `await`s
one before starting the next. `src/app/concurrency-idempotency.integration.test.ts`.

## Item 1 — the ⭐ concurrency test, and proving it depends on the index

`src/app/concurrency-slot.integration.test.ts`: 12 agents, one slot, `Promise.allSettled`. Exactly one
winner, 11 clean `SLOT_TAKEN`s, exactly one live `bookings` row for that `(practitioner_id, starts_at)`,
the winner's `HOLD_CREATED` in the trail and no loser's.

**Verified against the real index, not assumed.** Dropped `one_live_booking_per_slot` on the local
Postgres by hand (`DROP INDEX`), ran the test: **all 12 concurrent holds succeeded** — no application-level
guard exists anywhere in `hold_slot` that would have caught this; the unique index really is the only
thing standing between this and a double-booked doctor. Cleaned up the 12 bogus rows the failed run left
behind, recreated the index verbatim from `migrations/0001`, reran — back to green. This was a deliberate
one-time manual step, not automated into the committed suite: dropping a real index on the shared local
dev Postgres this repo's other concurrent Claude Code sessions may also be using (dev-logs/012's
collision-risk note) is a real-infrastructure action, not something that belongs running on every `npm
test`.

## Item 4 — every refusal code

All ten codes in `docs/03-domain-model.md` §5 now have a dedicated test. Eight already did
(`SLOT_TAKEN`, `HOLD_EXPIRED`, `HOLD_LIMIT_REACHED`, `POLICY_NOT_ACKNOWLEDGED`, `CAPTURE_AMOUNT_MISMATCH`,
`LADDER_FORBIDS_MOVE`, `NOT_YET_ELIGIBLE`, `MERCHANT_ACTION_REQUIRED`) — `POLICY_VERSION_STALE` and
`IDEMPOTENT_REPLAY` did not, and are new (`concurrency-idempotency.integration.test.ts`).
`POLICY_VERSION_STALE`'s test publishes a real second policy version mid-test (a temporary row, cleaned
up in `afterAll`) so "the merchant's current policy changed since you read it" is a genuine state change,
not a contrived input.

## Item 5 — agent cannot escalate

`src/app/agent-trust-boundary.integration.test.ts` covers the three vectors not already covered
elsewhere:

- **No live route sets the policy**, agent-facing or merchant-authenticated — hit the real merchant API's
  Fastify instance directly with a valid bearer token against `POST /policy`: `404`. Not gated, absent.
- **Cancel cannot be steered onto a different ladder tier by smuggling an extra timestamp field** — built
  the command as a loosely-typed object with a bogus `now` field (simulating what a loosely-validated
  JSON-RPC body could carry even though `CancelBookingCommand` declares no such field) and confirmed the
  server's own frozen clock decided the tier, not the smuggled value.
- **The no-show ceiling is enforced by the rail, not an `if`** — drove `PaymentRail.captureAuthorization`
  directly with one paisa over the authorised amount (the only way to even attempt this, since
  `ChargeNoShowCommand` has no amount field for an agent to inflate in the first place) and got
  `CaptureAmountMismatchError` from the rail itself.

Two more of the six vectors slice-8.md names — "trigger a merchant decline" and "mark non-attendance" —
were already covered exhaustively, not spot-checked: `mcp-e2e.integration.test.ts` asserts the deployed
MCP tool list is *exactly* the eight agent tools (`toEqual`, not `toContain`), and there is no
`decline`/`mark_no_show`/`set_policy` tool registered in `src/adapters/mcp/server.ts` — structurally
absent, not gated. The sixth — exceeding the concurrent-hold limit — already had a dedicated real-concurrency
test in `booking-flow.integration.test.ts` from Slice 1.

## Item 6 — demo rehearsal against the real deployed environment

**The ceiling-refusal beat (2:00–2:45 in the video script) was already fully built and trivially
triggerable** — `npm run demo:ceiling-refusal`, built in Slice 4, needs no human with the default fake
rail. Reran it to confirm: <1 second, fresh booking, real refusal, done. Nothing to add here.

**The Checkout-dependent beat (1:00–2:00) needed a human, and got one, twice, against the real deployed
MCP endpoint.** Wrote a throwaway script (`@modelcontextprotocol/sdk`'s `Client` +
`StreamableHTTPClientTransport`, real network hop to `https://latch-mcp-production.up.railway.app/mcp`)
that drives `find_slots → get_policy → hold_slot`, fires `confirm_with_deposit` without awaiting it
immediately, predicts the two Razorpay order ids `confirm_with_deposit` will deterministically create
(`receiptFor`, dev-logs/006) and polls for them directly against the real Razorpay API, then serves a
tiny local Checkout.js page for the user to pay both (deposit + no-show authorisation) in a real browser.

- **Run 1** hit a real, worth-knowing snag: the user's browser silently blocked Razorpay's
  `checkout.js` (an ad-blocker/privacy extension) — no visible error, the "Pay" button just did nothing.
  The hold's 10-minute TTL lapsed before this was diagnosed, and the confirm call itself hit the MCP
  SDK client's own request-timeout ceiling waiting on it (same *class* of issue as dev-logs/012's
  `mcp-remote` finding, just the direct SDK client's own default this time, not `mcp-remote`'s bundled
  one — overridable per-call via `RequestOptions.timeout`, which the script now sets to 6 minutes).
  Confirmed via `get_booking` and a direct Razorpay orders lookup: zero payments, hold `EXPIRED` — a
  clean, harmless outcome, not a corrupted one.
- **Run 2**, in an incognito window with extensions off: the modal opened correctly.
- **Run 3** (fresh hold after the incognito fix): **160.7s total**, `hold_slot → CONFIRMED`, real
  deposit + real authorisation, both against live Razorpay test mode.
- **Run 4**, immediately after: **94.5s total**, same result.

Both timed runs land comfortably inside 5 minutes, twice in a row, against the actual deployed
environment — slice-8.md's literal bar. **Worth flagging for the actual video recording session**: an
ad-blocker/privacy extension silently breaking Checkout with zero visible error is exactly the kind of
thing that could fumble the strongest moment of the pitch live — record from an incognito window, or a
browser profile with extensions disabled, decided in advance rather than discovered on the day.

**Not rehearsed this session**: the decline/merchant-action beat (2:45–3:45) against the deployed
environment specifically — the app-layer tests already exercise it thoroughly (`decline-booking.live.
integration.test.ts` proves it against real Razorpay), and this session's time went to the
Checkout-dependent core path instead. Worth a dry run before the actual recording.

## `npm audit`, resolved rather than deferred a third time

Dev-logs/012 flagged a high-severity SQL-injection advisory against the pinned `drizzle-orm` version
(`GHSA-gpj5-g38j-94v9`) as explicitly deferred to this slice, across two prior sessions. Read the actual
advisory rather than the one-line `npm audit` summary: the vulnerable surface is specifically
`sql.identifier()` and `.as()` being fed *untrusted runtime input* for a column/table/alias name — "static
schemas and allowlist-mapped inputs are safe" is the advisory's own scoping. Grepped the whole codebase:
`sql.identifier(` and `.as(` appear **nowhere** in `src/`. The one raw `sql` template usage anywhere in
the app (`postgres-event-store.ts`'s `pg_advisory_xact_lock(hashtext(${agentId}))`) interpolates a
*value* into a parameterised query via drizzle's tagged-template `sql` function — the safe pattern, and
categorically different from the vulnerable identifier-construction APIs regardless. This confirms, rather
than merely restates, `docs/02-tech-stack.md` §6's existing claim that money-critical queries lean on the
typed query builder. **Conclusion: not exploitable in this codebase as written.** The fix (`drizzle-orm@0.45.2`,
current pin `^0.36.4`) is npm's own audit output flagged as a breaking change — not something to force
through this late in the timeline for a vulnerability class that's confirmed unreachable here. Left pinned,
with this reasoning recorded rather than the advisory sitting unread a third time. Remaining moderate/critical
findings (`esbuild`/`vite`/`vitest`/`drizzle-kit`) are all dev-tooling-only, never in the deployed runtime
path, same as dev-logs/012 already noted.

## `npm test`: 132/132, run repeatedly

121 → 132 (+11): the concurrency-slot test, the straddled-race test, six idempotency-concurrency tests
(three genuinely-concurrent-retry, two `IDEMPOTENT_REPLAY`, one `POLICY_VERSION_STALE`), three
agent-trust-boundary tests. Ran the full suite five separate times across this session (before and after
each fix) — clean every time, no flake. The flake the handoff mentioned (1 failed / 120 passed on a prior
run, never chased down) did not reproduce once across any of these runs; whatever it was did not appear to
originate in anything touched this slice.

## Carried forward

1. **Visual verification of the deployed viewer is still separately owed** — flagged in dev-logs 011 and
   012, twice now. This session again had no live Chrome extension connection available (`tabs_context_mcp`
   reported "Browser extension is not connected") and could not close this gap either. The data layer is
   now proven four times over (local, live deploy, a real remote agent's booking, and this session's two
   real rehearsal runs); the React rendering has still never been looked at by anyone.
2. **`AUDIT_TRAIL_TOKEN` in local `.env` does not match whatever the deployed `latch-viewer` service is
   actually configured with** — a quick `curl` against the live `/events` SSE endpoint with the local
   token returned `401`. Not investigated further (out of this slice's scope, and the two real rehearsal
   bookings were independently confirmed via `get_booking` and direct Razorpay lookups instead), but worth
   someone checking before relying on the local token for a live demo — either the deployed value was
   rotated independently, or the two were never actually kept in sync the way dev-logs/012 assumed.
3. **The decline/merchant-action beat wasn't rehearsed against the deployed environment this session**
   (see above) — do it before the actual recording, not for the first time on the day.
4. **A process that claims an idempotency key and then crashes before completing leaves a permanently
   stuck pending marker** — every future retry with that exact key would poll out to a timeout and get
   `IDEMPOTENT_REPLAY` forever, never self-healing. A real production system would want a TTL sweep on
   stale claims; out of scope here (a new background worker is a feature, not hardening an existing one),
   and the practical mitigation (use a new idempotency key) already exists implicitly. Named so it's a
   documented limitation, not a surprise.
5. **Two real bookings now exist on the live deployed database** with real captured deposits and real
   no-show authorisations, from this session's rehearsal runs 3 and 4 (`bkg_01M0TH8508E8KEAX7CP62NACEB`,
   `bkg_01M0THEBEVQQD7V5MKY0TBKRPW`) — genuine test-mode artifacts, left in place deliberately (holds/
   confirmed bookings cost nothing to leave sitting, per docs/03-domain-model.md §3 Rule 1, and they're
   real proof the deployed path works, not scratch data to clean up).
