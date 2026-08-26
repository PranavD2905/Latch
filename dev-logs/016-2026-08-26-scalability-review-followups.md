# Dev Log 016 — backfilling `5ed1ac7`, then an SDE3-style scalability review

**Date:** 26 August 2026
**Phase:** Two things in one entry, per this project's own convention of writing the log that matches
what actually happened rather than forcing one shape: Part 1 backfills the dev log `5ed1ac7` shipped
without one — the only gap in an otherwise-unbroken chain since dev-logs/003 — and Part 2 is this
session's own new scope, a second architecture review (Copilot-generated, "how would an SDE3 judge
this for scalability and failure handling") handed over by cross-session message, curated against what
was already built before this session started work.
**Status:** Both genuinely-new "build this" items built and tested. Every judgment-call item evaluated
with reasoning recorded, not silently skipped. `npm test`: 202/206 passing — the 4 failures are a single
pre-existing, out-of-scope root cause (below), not a regression. `npx tsc --noEmit` (root) and `npx tsc
-b` (web) both clean.

---

## Part 1 — backfilling `5ed1ac7`: "Harden scalability: multi-tenant auth, SSE fan-out, bounded reconciliation, safe replica scaling"

This commit landed with a real, substantial diff (56 files) and no dev log. Reconstructed from `git show
5ed1ac7` and the doc updates it already made directly (`docs/01-architecture.md` §10,
`docs/07-deployment.md`'s "Scalability hardening" section) — the commit's own author already wrote good
doc prose for most of this; what was missing was the decision-log entry, not the doc content.

**Migration 0011 — real multi-tenant auth.** Superseded `docs/01-architecture.md` §10's "not
multi-tenant" non-goal (kept there, struck through, per that doc's own convention for a reversed
decision — same pattern this entry uses below for the multi-tenancy row in
`04-features-and-limitations.md`, which had gone stale and is fixed as part of this backfill). Per-merchant,
DB-issued credentials (`merchant_credentials` table, `src/ports/merchant-auth.ts`) replace the single
static `MERCHANT_API_TOKEN`/`AUDIT_TRAIL_TOKEN` env vars; `bookings`/`events` gained a `merchant_id`
column (backfilled to the one pre-existing seed merchant, since that's a fact about this system's
history up to this exact migration, not a guess); the MCP surface gained a `/mcp/:merchantId` route;
`npm run db:create-merchant` onboards a new merchant with no redeploy. What made this cheap to reverse
later is what made it cheap to skip earlier: `merchantId` was already threaded through every catalog
table and command handler from Slice 0 (`AppDeps.merchantId`) — only the auth model and inbound routing
were ever actually single-tenant.

**SSE fan-out.** The audit-trail viewer used to poll once per connected browser tab — N viewers of one
merchant meant N independent `listAllEvents` queries every 500ms. Now one shared poll per merchant,
fanned out in-process to every listener for that merchant.

**Bounded reconciliation concurrency.** `src/app/concurrency.ts`'s `mapWithConcurrency` — a small,
dependency-free worker pool (the entire shape `p-limit` provides, sized for exactly what
`reconciliation-worker.ts` needs) — replaced a fully-sequential scan. 8 candidates in flight at once:
enough to keep a tick's wall-clock cost roughly flat as booking volume grows, without turning a routine
reconciliation pass into a burst Razorpay's own rate limiter would flag.

**Safe replica scaling — the advisory lock.** `src/adapters/db/advisory-lock.ts`'s `withGlobalLock`:
`pg_try_advisory_lock` on a `sql.reserve()`d connection (a session-level lock, not the
`pg_advisory_xact_lock` `postgres-event-store.ts` already used elsewhere for `lockAgent` — a background
tick spans several independent transactions, so there's no single transaction to scope a lock to; a
reserved connection is what guarantees the acquire and the release happen on the same Postgres session,
since `pg_advisory_unlock` only works from the session that took the lock). This is what actually makes
`replicas > 1` on `latch-mcp` safe: `FOR UPDATE SKIP LOCKED` already made each row-level *claim* correct
under concurrent workers, but for the reconciliation leg specifically, N replicas each running a full
tick means N× the external Razorpay API load for the same unit of work, not more work getting done —
the advisory lock guards the whole tick, not just each row.

**Pooler readiness.** `createDbClient` gained `idle_timeout`/`max_lifetime` (hand back connections a
replica isn't using, rather than holding `DB_POOL_MAX` open regardless of load) and a
`DB_TRANSACTION_POOLER` flag (`prepare: false` when a PgBouncer/Railway-pooling layer sits in front of
Postgres, since transaction-mode pooling hands a different backend connection to each transaction and a
session-scoped prepared statement from one transaction can silently run against the wrong backend in the
next). Not itself infrastructure — the code is ready for a pooler; nothing was provisioned.

This is why the second architecture review's item "worker replica-safety / leader election" is judged
already-covered below rather than rebuilt: the advisory lock above already gives every background worker
safe-under-concurrency behaviour at zero additional infrastructure, which is what that recommendation is
actually asking for.

---

## Part 2 — the second review: what's genuinely new, what's already covered, what's deliberately declined

The user got a second, independent SDE3-style review and asked for it implemented. Read against dev-logs
013/014/015 and the `5ed1ac7` backfill above before starting, specifically to avoid rebuilding what
already exists — real overlap turned up (reconciliation, idempotent webhooks, rate limiting, replica
safety, pooling readiness all pre-date this review) and one recommendation (a job queue) directly
revisits a decision `docs/02-tech-stack.md` §9 made deliberately. Confirmed scope and the push gate with
the user before starting, given the size of the ask relative to how close the buildathon deadline is.

### Environment, first — two real gaps found before any feature work

1. **`npm test` pointed at `postgres://...localhost:5433/latch_test` (commit `746573a`) and nothing was
   listening on port 5433.** Stood up a second, genuinely separate local Postgres cluster — `initdb`'d a
   native cluster at `~/.latch-test-pg-data` using the binaries bundled in `/Applications/Postgres.app`
   (this project's established preference against Docker for Postgres specifically, dev-logs/003), port
   5433, trust auth matching the main dev cluster's own `pg_hba.conf`. Migrated and seeded it.
2. **The real local dev Postgres (port 5432) had never had migration 0011 applied**, a second, separate
   gap from the port-5433 one — `hold_slot` over the real stdio MCP entrypoint was silently failing with
   `PostgresError: column bookings.merchant_id does not exist`, reproduced directly (not assumed) by
   driving the actual subprocess with the MCP SDK client and reading the raw tool response, which showed
   the real error rather than the misleading downstream symptom (`held.bookingId` being `undefined`, then
   `afterAll`'s cleanup throwing `UNDEFINED_VALUE` trying to delete by that `undefined` id — a real error
   two layers removed from its actual cause, the kind dev-logs/013's "reproduce it, don't assume" already
   argues for). Ran `db:migrate` + `db:seed` against port 5432 to close it. Neither gap was something a
   fresh `npm test` run before this session would have survived.

**A separate, time-critical finding, unrelated to any code change here: the Razorpay test-mode API keys
in `.env` have expired.** Confirmed directly — `curl -u $RAZORPAY_KEY_ID:$RAZORPAY_KEY_SECRET
https://api.razorpay.com/v1/orders` returns `"The api key provided by you has expired and cannot be
used."` This is the actual root cause of every live-Razorpay test failure this session saw (3 tests in
`razorpay-payment-provider.live.integration.test.ts`, consistently; occasionally a 4th in
`decline-booking.live.integration.test.ts`, which hits a hardcoded real-payment fixture and so should in
principle fail exactly as consistently — the intermittency there wasn't chased further, since the root
cause is already identified and out of this session's ability to fix). **Flagged to the user directly,
mid-session, rather than only in this log** — an expired key breaks the real Checkout-dependent path of
the demo itself (dev-logs/013's rehearsal runs), not just these three tests, and needs new test-mode keys
generated from the Razorpay dashboard before recording. `npm test`'s 202/206 is genuinely green modulo
this one, named, external, non-code cause.

### Genuinely new — built

**1. A circuit breaker on the reconciliation worker's own outbound Razorpay calls.**
`src/app/circuit-breaker.ts` — closed/open/half-open, three consecutive failures opens it, a 2-minute
cooldown before one half-open probe decides whether to close again. In-memory, one instance per process
(`AppDeps.reconciliationCircuitBreaker`, built once in `build-deps.ts` and shared across every merchant a
process serves) — the same "no second datastore for two low-frequency jobs" reasoning
`docs/02-tech-stack.md` §9 already gives, and it doesn't need to survive a restart: a fresh process
re-learns "Razorpay is down" on its very next failed call, at most one tick slower than a persisted
breaker would be. Takes a `Clock`, not `Date.now()`, for the same reason every other timing-sensitive
thing in this codebase does — `circuit-breaker.test.ts` drives the full
closed→open→cooldown→half-open→closed cycle with a `FrozenClock`, deterministically, not a real sleep.

Wired into `reconciliation.ts`'s two Razorpay lookups (`fetchPaymentStatus`/`fetchAuthorizationStatus`).
**A second, related fix found while wiring it in, not part of the original ask:** the worker's
per-candidate loop previously let *any* thrown error — not just a `CircuitOpenError` — propagate out of
`mapWithConcurrency`'s `Promise.all`, which would have discarded every other candidate's already-good
result in the same tick over one candidate's real network failure. Restructured so a failed candidate
check (open circuit, or a genuine one-off provider error) is caught per-candidate, logged, and skipped —
re-checked next tick, same as if this tick hadn't run for that one booking — rather than sinking the
whole batch. Two tests in `reconciliation-worker.integration.test.ts` pin this: one proves the breaker
stops calling a Razorpay that's already open (zero network calls, deterministically — the breaker is
pre-tripped with sequential priming failures rather than relying on concurrent candidates to race it
open, which would make the test's own pass/fail depend on I/O timing) and recovers on its own once the
cooldown elapses; the other proves one candidate's failing call doesn't discard a different candidate's
real mismatch finding in the same tick.

**2. Webhook dead-lettering.** New `webhook_dead_letters` table (migration `0012`,
`src/ports/webhook-dead-letter-store.ts` / `postgres-webhook-dead-letter-store.ts`). `POST
/webhooks/razorpay` (dev-logs/014) already retried safely on any failure — signature-verified, idempotent
on Razorpay's own event id. What it had no answer for was a delivery that fails the *same way* every
single time (a bug in this handler, a malformed payload, an order that no longer resolves): Razorpay
would redeliver it for days, and every redelivery would fail identically, with nothing durable to show
for it but a climbing, invisible count in Razorpay's own dashboard. `WEBHOOK_MAX_ATTEMPTS = 5` (Razorpay
spaces real redeliveries out over hours, so 5 consecutive failures already spans a meaningful chunk of
real time, not five rapid-fire retries a transient blip would explain) — past that, the route acks with
`200` (stop asking Razorpay to retry something more retries won't fix) instead of `500`, and records the
delivery as dead-lettered instead. Logged loudly (`console.error`) on the transition, matching this
project's existing "report, don't silently swallow" posture for reconciliation findings.

Tested in `merchant-api.integration.test.ts` with a payload no real Razorpay webhook would ever send
(`amount: 12.5` — money is always integer paise, so `toPaise` throws deterministically on every identical
redelivery) rather than trying to simulate a flaky network call, which would make the test itself
nondeterministic. Proves: the first `WEBHOOK_MAX_ATTEMPTS − 1` deliveries still 500 (Razorpay's own retry
schedule is still the right thing happening); the `WEBHOOK_MAX_ATTEMPTS`th acks `200` with
`deadLettered: true`; a further redelivery after that stays acked, not resurrected into another 500; and
the row's `attemptCount`/`lastError` land correctly in the table.

**Deliberately not built alongside this: a read/inspection surface (an HTTP endpoint or a viewer tab) for
dead letters.** The table has no reliable `merchantId` at record time — a webhook whose own `bookingId`
resolution is what's failing has nothing to correlate it to a tenant with — so any authenticated-merchant
read endpoint over it would either leak other merchants' webhook failure payloads (real Razorpay payment
ids, amounts) across the tenant boundary migration 0011 just built, or need to guess a merchant to scope
by. Given this project's own trust-boundary bar (dev-logs/013's `agent-trust-boundary.integration.test.ts`
is entirely about not doing exactly this kind of thing), the honest choice was to persist the data
durably and log loudly, and name "no read surface yet" as a real, deliberate limitation rather than rush
a cross-tenant leak in under time pressure. `04-features-and-limitations.md` was not updated with this
specific row — recorded here since it's a limitation of work built *this* session, not a pre-existing one
a judge could already find.

**3. A chaos test for a real payment-provider outage, driven through the actual command, not around it.**
`src/app/chaos-payment-outage.integration.test.ts`. `confirm_with_deposit` runs the deposit capture and
the no-show authorisation *concurrently* (`Promise.all`, since a human waiting on both Checkout
completions shouldn't wait on them serially) — which means a partial outage, one leg succeeding while the
other fails, is a real, reachable production state, not a hypothetical. Dev-logs/014 item 2 already
*claimed* the webhook path is what recovers a `HELD` booking whose deposit genuinely captured before a
crash — but every existing reconciliation test manufactured that mismatch by calling
`paymentProvider`/`paymentRail` directly, bypassing the command that would actually produce it. This test
wraps a real `PaymentRail` so `authorize` throws for one specific idempotency key while `captureDeposit`
succeeds normally, drives the real `confirmWithDeposit`, and proves: the booking is left `HELD`, not
corrupted; the trail genuinely has no `DEPOSIT_CAPTURED` event despite the deposit having really
captured (verified by replaying the same idempotency key against the fake provider and reading its
status back — idempotent by the provider's own design, so this reads back what really happened rather
than charging again); and delivering the corresponding `payment.captured` webhook through
`reconcileObservedPayment` is what actually notices and records the drift, never auto-repairing it into
`CONFIRMED`. This is the first test to pin dev-logs/014's own recovery claim against the real command
path rather than only against the reconciliation primitives in isolation.

Considered and not built: literal database-failover or network-partition chaos testing (killing the
Postgres process mid-transaction). The now-controlled, throwaway port-5433 cluster this session stood up
makes that *possible* for the first time — but it's the single connection pool every concurrent test in
the suite shares, and vitest runs test files sequentially in one process, so stopping it mid-run would
risk corrupting every other test's state for one test's benefit, on a repo this project's own convention
(dev-logs/012) already flags as sometimes shared by concurrent Claude Code sessions. Judged out of
proportion to the value for a buildathon submission; the standard, non-destructive port-boundary failure
injection above is the same technique this project already uses for every other failure scenario
(`FakePaymentProvider`'s decline/timeout scenarios, this session's own outage double).

### Evaluated, and the existing decision reaffirmed — not rebuilt just because an external review named it

**No Redis / job queue.** `docs/02-tech-stack.md` §9 gained an explicit "re-reviewed, not just
re-asserted" addendum. The review's ask — background jobs that stay correct under concurrent workers —
was already true the day that doc was written (`FOR UPDATE SKIP LOCKED`) and is more true now that
`5ed1ac7`'s advisory lock makes a whole tick, not just one row's claim, safe to run from more than one
replica, at zero additional infrastructure. A queue would add a second datastore and a second failure
mode to re-solve an already-solved problem. Checked against the strongest form of the counter-argument,
not merely repeated because the original doc said so.

**Read replicas.** Genuinely not provisioned. The pooler-readiness flags `5ed1ac7` already added mean the
*code* is ready; standing up a second Postgres instance is real infrastructure spend and a topology
change to `docs/07-deployment.md`'s three-service model, which is a decision for the user to make
directly, not something a background-hardening session should do unilaterally (same reasoning
dev-logs/012 already established for provisioning new infrastructure). Documented in
`07-deployment.md`'s new section rather than provisioned.

### Evaluated, reasoning recorded, deliberately not built

- **A formal outbox table** for payment-authorisation ↔ event-append atomicity. Every money-moving
  handler already uses the gate/network-call-outside-lock/final-transaction shape (dev-logs/004), and the
  reconciliation worker + webhook independently verify the *outcome* against Razorpay's own record —
  which is what an outbox exists to guarantee, and doing it by asking the payment provider directly is
  strictly stronger than a second local write would be (it checks ground truth, not another thing that
  could itself drift). Recorded in `04-features-and-limitations.md` §2.2.
- **Snapshotting/read-models** for `get_booking`/`find_slots`. Real event-history depth doesn't exist yet
  at buildathon scale to make this pay for itself, and it would introduce a second representation of
  booking state to keep consistent with the fold — exactly the drift risk `01-architecture.md`'s "the
  trail *is* reality" claim exists to avoid. Named as the scaling plan (a `booking_snapshots` table,
  invalidated by sequence number) in `04-features-and-limitations.md` §2.2, not built speculatively.
- **Event-table partitioning.** `05-cost-model.md`'s existing Tier-3 section already named this; the plan
  was made concrete rather than rebuilt — `PARTITION BY LIST (merchant_id)` is now the actual best answer
  given migration 0011 made `merchant_id` a real column, not `RANGE` on time alone. Still not implemented:
  a real `ALTER TABLE ... PARTITION BY` migration would be exercising a scaling decision against data
  that doesn't exist yet to validate it against.
- **A merchant-wide hold-rate ceiling**, on top of the existing per-agent-per-merchant one. The existing
  ceiling (dev-logs/014, and merchant-scoped for free by migration 0011's `merchant_id` columns) bounds
  one agent's own re-holding rate; a merchant-wide ceiling would bound many *distinct* hostile agents
  coordinating against one merchant instead. Considered and declined: that's new policy surface for a
  threat model with no evidence it's the actual risk here, versus one agent re-holding, which is real and
  already closed. Recorded in `04-features-and-limitations.md` §2.2.
- **Telemetry** (events/sec, reconciliation lag, authorisation success/fail rates). Lower priority per the
  review's own framing, and this session's time went to the higher-priority items above instead — the
  existing `console.log`/`console.error` lines each worker already emits on a real state change are the
  telemetry that exists today. Not built this session; a real dashboard or structured-log pass is a
  reasonable next slice, not squeezed in under this one's time budget.

### What was explicitly declined, per the brief

Dispute/chargeback flows, merchant-onboarding UX polish, and a sandbox/preview mode — real suggestions in
the underlying review, but out of scope for "scalability and failure handling" specifically, and this
project's whole convention has been narrow, complete units of work over broad ones.

### A stale doc/comment fixed along the way

`src/app/types.ts`'s `AppDeps` doc comment still said `merchantId` was there "because this is
deliberately not multi-tenant" — true when Slice 1 wrote it, false since migration 0011, and never
updated. Fixed while touching this file for the circuit-breaker/dead-letter fields, same as the
`04-features-and-limitations.md` multi-tenancy row above — this project's own rule (`prompts/README.md`)
is that a session which finds a doc (or a doc-equivalent comment) that contradicts reality fixes it
rather than working around it.

## `npm test`: 198 → 206 (+8)

4 `CircuitBreaker` unit tests, 2 reconciliation-worker circuit-breaker integration tests, 1 webhook
dead-letter integration test, 1 chaos payment-outage integration test. Every existing `AppDeps`-shaped
test fixture (16 files) updated mechanically to construct the two new required fields
(`reconciliationCircuitBreaker`, `webhookDeadLetterStore`) — checked for a uniform construction pattern
across all of them before scripting the edit, rather than assuming one. 202/206 passing; the 4 failures
are entirely the pre-existing, external, already-flagged expired-Razorpay-test-key issue above, not a
regression from anything in this session — confirmed by isolating each failing file and by running the
full suite multiple times to separate the 3 consistent failures from the 1 intermittent one.

## Carried forward

- **New test-mode Razorpay API keys are needed before the demo can be recorded** — flagged to the user
  directly and prominently above; this is the most time-critical item in this entire log.
- Every carry-forward item from dev-logs/013/014/015 this session's scope didn't touch (visual
  verification of the deployed viewer, the `AUDIT_TRAIL_TOKEN` mismatch, the stuck-idempotency-claim TTL
  sweep, the periodic reconciliation pass's `HELD`-booking gap — though this session's chaos test is the
  first thing to actually exercise why that gap is closed by the webhook specifically).
- **Webhook dead-letters have no read/inspection surface** — named above as a deliberate, trust-boundary-
  motivated deferral, not an oversight.
- **The isolated second Postgres cluster this session stood up (`~/.latch-test-pg-data`, port 5433) is
  local to this machine** — a future session on a different machine (or a fresh checkout) would hit the
  exact `ECONNREFUSED` this session diagnosed. Documented the setup steps in `docs/07-deployment.md`'s new
  "Local development needs two Postgres clusters" section so the next session that hits this reads a
  fix, not a mystery — but the cluster itself is still a one-machine, not-committed, not-automated setup
  step, not a script.
