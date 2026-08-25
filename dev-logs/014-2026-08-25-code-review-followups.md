# Dev Log 014 — code-review follow-ups: reconciliation, webhooks, hold-spam, a second adapter, MDR live

**Date:** 25 August 2026
**Phase:** New scope from a code review (no `prompts/slice-9.md` — the review that generated this work
described itself as "how would a senior Razorpay SDE judge this," and the user explicitly signed off on
building all five of its recommendations, not a subset).
**Status:** All five items built. `npm test` green (156/156, up from 132), run three times with no
flakiness observed. Real webhook registered against Razorpay's live Webhooks API, pointed at the actual
deployed `latch-merchant-api` service.

---

## What the review found

Two real gaps, not hypotheticals:

1. **No webhook listener anywhere.** Every money-moving action trusted the synchronous HTTP response
   from Razorpay alone. If Latch's own server crashed between Razorpay confirming a capture and Latch's
   local transaction appending `DEPOSIT_CAPTURED`, nothing would ever notice — the exact same failure
   shape `get_booking` already exists to cover one hop closer in (dev-logs/012's `mcp-remote` timeout),
   just one hop further out and with no mitigation at all.
2. **The unauthenticated MCP endpoint's existing justification answers *identity*, not *abuse rate*.**
   `hold_slot` moves no money — that's what makes it cheap to abuse. A hostile agent sitting at
   `max_concurrent_holds_per_agent` and re-holding as fast as TTLs lapse can lock a merchant's calendar
   out from under legitimate agents, with zero money moved and therefore zero payment trail.

Five things to build, all signed off:

1. Reconciliation worker
2. Real, signature-verified webhook handler
3. Name and mitigate hold-spam
4. A second inbound adapter (prove the "architecture is the argument" claim)
5. Surface the MDR cost live in the viewer

---

## Item 1 — the reconciliation worker

`src/app/reconciliation-worker.ts` + `src/app/reconciliation.ts`. Follows the exact shape
`hold-expiry-worker.ts`/`authorization-lapse-worker.ts` established, adapted for the one thing neither of
those workers does: a real network call to Razorpay. Two new read-only port methods —
`PaymentProvider.fetchPaymentStatus`/`PaymentRail.fetchAuthorizationStatus` — reused exactly as the task
specified, no new outbound integration. Scoped to `CONFIRMED` bookings ("open bookings," per
docs/01-architecture.md §8): for each, compares the trail's `DEPOSIT_CAPTURED`/`AUTHORIZATION_HELD`
claims against what Razorpay's own API says *right now*, and appends `RECONCILIATION_MISMATCH` on
disagreement.

**The discipline that mattered most: never hold a DB lock across the Razorpay lookup.** Every existing
money-moving handler in this codebase (`confirm_with_deposit`, `decline_booking`, `charge_no_show`)
already follows a gate-transaction → network-call-outside-any-lock → final-transaction shape
(dev-logs/004). First draft of this worker did the SKIP-LOCKED claim and the network calls inside one
transaction — caught before it shipped, by re-reading dev-logs/004 rather than by a failing test. Fixed
to the same three-phase shape: `listOpenBookingsForReconciliation` (unlocked read), the two Razorpay
lookups (no lock), then `loadSnapshotForUpdate` + a dedup check + `append` (re-locked, briefly).

**Dedup, not a new schema column.** A persistent mismatch (say, a payment manually refunded outside
Latch's flow and never fixed) would otherwise get a fresh `RECONCILIATION_MISMATCH` every single tick
forever. Rather than adding a `lastReconciledAt` column — which would have meant writing the projection
on every tick even when nothing changed, violating docs/03-domain-model.md §1's "no `UPDATE` without a
causing event" rule — the worker re-reads the booking's own history under the lock and skips a finding
that would just repeat the most recently recorded one for the same subject+id. A real state change (the
mismatch resolves, or changes shape) gets recorded again; a static one doesn't spam the trail.

**Verified with real Razorpay port calls, not just fakes.** `src/app/reconciliation-worker.integration.test.ts`
drives a real `confirmWithDeposit` against `FakePaymentProvider`/`FakePaymentRail`, then calls
`paymentProvider.refundDeposit`/`paymentRail.captureAuthorization` *directly* (bypassing
`decline_booking`/`charge_no_show`) to simulate money moving at Razorpay outside Latch's own flow — the
same shape a merchant manually refunding something in the Dashboard would produce. The worker correctly
finds both the deposit mismatch (trail says captured, Razorpay now says refunded) and the authorization
mismatch (trail says authorized, Razorpay now says captured), and a second immediate run doesn't
duplicate either finding.

## Item 2 — the webhook, and the decision to scope it narrowly

`POST /webhooks/razorpay`, mounted on the already-deployed, already-public `latch-merchant-api` Fastify
instance rather than a new service — see the deployment-topology note below.

**Signature verification first, before anything else.** `verifyRazorpayWebhookSignature`
(`src/adapters/payment/razorpay-shared.ts`): HMAC-SHA256 hex digest of the *raw* request body against
the webhook secret, compared with `timingSafeEqual`. This needed the raw bytes, not
`JSON.stringify(request.body)` re-serialised — Fastify's default JSON parser discards them, so
`createMerchantApiServer` now registers a custom `application/json` content-type parser that captures the
buffer alongside the normal parse, scoped to the whole instance but harmless to every other route (they
still get the same parsed object they always did). An invalid or missing signature is `400` before the
payload is even read as a Razorpay event.

**The narrowest possible thing a verified webhook is allowed to do.** It never appends
`DEPOSIT_CAPTURED`/`AUTHORIZATION_HELD` directly — reconstructing a gate/bound/authority quad from a
webhook payload alone, outside the domain core's actual decision path, is exactly the kind of
unaccountable money-adjacent write Idea 2 exists to prevent. The only thing it can ever cause is a
`RECONCILIATION_MISMATCH`, through the *same* `reconcileObservedPayment`/`appendReconciliationFindings`
path the periodic worker uses. This is deliberately the real-time twin of item 1, not a separate feature
— webhook payload in, same event type out, same dedup logic, same "report, don't auto-repair" posture.

**Correlating a webhook payload to a `bookingId`.** Razorpay's webhook body carries `payment.entity.id`
and `payment.entity.order_id`, never a bookingId — that's Latch's own concept. Fixed by setting
`notes: { bookingId: reference }` on every order Latch creates (`RazorpayPaymentProvider.captureDeposit`,
`ManualCaptureRail.authorize`), then having the webhook handler fetch the order by `order_id` and read
`order.notes.bookingId` back. Deliberately *not* trusting `payment.entity.notes` directly — it's not
reliably a copy of the order's notes on every Razorpay payment-creation path, and the order fetch is one
extra, cheap, unambiguous lookup rather than a guess.

**Idempotent on Razorpay's own event identity**, reusing the `IdempotencyStore.claim`/`put`/`release`
primitive dev-logs/013 added — `(scope: 'razorpay_webhook', key: '{event}:{entityId}')`. Razorpay
redelivers on anything but a `2xx`, so this needed to be a real replay-safe claim, not a courtesy: a
redelivered `payment.captured` for a booking already reconciled must return the stored `{replayed: true}`
outcome, not re-run the check (harmless here since the check is idempotent by construction anyway, but
the pattern matters more broadly than this one handler).

**Deliberately narrow event set** (`payment.captured`, `payment.authorized` only) — every other event
Razorpay might send either moves no money or is already something Latch itself initiates and
synchronously records (a refund is always `decline_booking`/`cancel` appending `REFUND_ISSUED` itself).
Named explicitly in the code rather than left implicit, since narrow-and-documented beats
broad-and-unverified for a security-adjacent surface.

**Registered for real, not left as a manual step.** The task said: do it via API if the existing
credentials allow it, say so clearly if they don't. They did — `razorpay.webhooks.create()` is callable
with the same test-mode API key/secret already in `.env`, no partner/OAuth scope needed. One real gotcha
hit and fixed: the SDK's own TypeScript signature types `events` as `any`, and passing an array
(`['payment.captured', 'payment.authorized']`) fails server-side with `"Invalid event name/names: 1, 2"`
— Razorpay's actual API wants an `{eventName: boolean}` map. Fixed, then verified: `webhooks.create`
returned a real webhook object (`id: TU1SBaECAYd82C`), `active: true`, pointed at
`https://latch-merchant-api-production.up.railway.app/webhooks/razorpay`, with exactly the three events
requested enabled and everything else off. The matching `RAZORPAY_WEBHOOK_SECRET` was set on the
deployed `latch-merchant-api` service via `railway variable set` before this was registered, and
`.railway/railway.ts` was updated to declare it (`preserve()`, same convention as every other secret in
that file) so the topology stays reviewable rather than tribal knowledge. Live end-to-end verification —
against the actually-deployed route, not just local `.inject()` tests — is recorded below, after the
deploy that ships this code actually ran.

## Item 3 — hold-spam: built the real rate ceiling, not just a documented risk

The review's own guidance was "pick based on remaining time." There was enough time to build it for
real, so it was built for real: `Policy.holdRateLimitPerMinute`, a new versioned policy field (migration
`0009`, alongside the new `RECONCILIATION_MISMATCH` event-type enum value in the same migration — both
additive, no data loss, `drizzle-kit generate` produced a clean single file and the timestamp landed
naturally ahead of `0008`'s hand-bumped value this time, no manual fix needed per dev-logs/010's
gotcha-check). Enforced inside the exact same `lockAgent` advisory-lock transaction `hold_slot` already
opens for the concurrent-hold check — the two bounds are atomic against one serialised window per agent,
no new race introduced to close a different one.

**A real bug, caught by the test, not by inspection.** First implementation counted `bookings.createdAt`
rows in the rolling window. First test run: the third hold succeeded when it should have been refused.
Root cause: `bookings.createdAt`/`updatedAt` are set from real wall-clock `new Date()` in
`postgres-event-store.ts`'s `appendFor` — the *one* place in this whole codebase that isn't on the
domain `Clock`'s timeline (docs/01-architecture.md §5: "the server clock is the only clock," but that
principle was never claimed for DB bookkeeping metadata, only for domain-meaningful timestamps). The
test's `FrozenClock` was set to a fictional September 2026 date; `windowStart` was computed from it;
`bookings.createdAt` was real wall-clock "now" (whatever the actual system date is), which sits nowhere
near that fictional window. Invisible in production, where `Clock` *is* the wall clock — exactly the
kind of bug this project's own convention (frozen-clock tests as the thing that catches timeline
mismatches, dev-logs/007/008/010/013 all found similar things this way) exists to surface. Fixed by
counting `HOLD_CREATED` *events* joined to `bookings` for the agent, filtered on `events.occurredAt`
(which *is* on the domain clock's timeline, since it's written from `Clock.now()`) instead.

**Why this and not "document it as a risk."** The query needed (count of `HOLD_CREATED` events for an
agent since a timestamp) was cheap against the existing schema once the join was right, and a real,
DB-verified, atomic-with-the-existing-lock ceiling is a materially stronger claim than a documented gap
— consistent with every other bound in this system being enforced by something that can't be talked out
of it, not merely described. Named as a fixed-window (not sliding-bucket) approximation in
docs/04-features-and-limitations.md rather than oversold as perfect.

## Item 4 — the second inbound adapter

`GET /slots` (`src/adapters/rest/slots.ts`) calls the identical `findSlots` app-layer function
`find_slots` calls, with zero changes to `src/domain/` or `src/app/`. `registerSlotsRoute` is a plain
function, not a `createXServer()` — used by a genuinely standalone `src/adapters/rest/server.ts` (so the
claim "this needs nothing merchant-api-specific" is checkable by running it alone,
`npm run rest:dev`) *and* mounted onto `merchant-api`'s already-public, already-deployed Fastify instance
for real reachability without a fourth Railway service. Same function, two servers — proof of reuse, not
two implementations that happen to agree today.

**Test asserts byte-identical output against the direct call**, not just "both return 200":
`merchant-api.integration.test.ts`'s new `/slots` block calls `findSlots` directly and `toEqual`s it
against the HTTP response — if this route ever diverged from `find_slots`'s own behaviour, that would be
a bug in `findSlots` itself, not two adapters silently drifting apart.

## Item 5 — MDR live in the viewer

`web/src/totals.ts` gained `sunkMdrPaise` (`RAZORPAY_MDR_RATE = 0.0236`, the same 2% + 18% GST figure
docs/05-cost-model.md already sources and works out to ₹7.08 on a ₹300 refund) — computed from every
`REFUND_ISSUED` event's amount, the same "derive from event type, don't trust a pre-summed field"
discipline `totals.ts` already used for running totals (dev-logs/011). Surfaced two places: an annotation
under the "Merchant retention" stat card ("−₹7.08 sunk MDR"), and a per-event note in the expanded
`REFUND_ISSUED` detail panel ("MDR ₹7.08 not recovered — borne by merchant"), matching the worked trace's
own prose in docs/03-domain-model.md §6 almost verbatim. `docs/05-cost-model.md` updated to cross-reference
this — the number is no longer doc-only.

## Decisions the docs didn't settle

- **Webhook mounted on `merchant-api`, not a fourth Railway service.** Both `/slots` and
  `/webhooks/razorpay` ride the existing three-service topology. Provisioning new infrastructure is a
  real decision the project's own convention treats carefully (dev-logs/012 explicitly deferred it to
  the user); this task's brief explicitly authorised deploying *new code* to the *existing* services, so
  that's what happened.
- **The webhook can only ever produce `RECONCILIATION_MISMATCH`, never a money event directly.** Covered
  above — the alternative (reconstructing a full money event from a webhook payload) would have put an
  unaccountable write outside the domain core's own decision path, which is the opposite of what this
  project is trying to prove.
- **Reconciliation's periodic pass only scans `CONFIRMED` bookings; the webhook path is what covers a
  `HELD` booking whose deposit actually landed at Razorpay right before a crash.** Named explicitly as a
  scoped limitation in docs/04-features-and-limitations.md rather than silently narrower than the gap-1
  framing might suggest — the webhook path (real-time, triggered by Razorpay regardless of Latch's own
  status projection) is what actually closes that specific worst case; widening the periodic scan to
  `HELD` bookings too is a small, named follow-up.
- **Rate ceiling is a fixed 60s lookback, not a token bucket.** Simplest thing that is still a real,
  atomic, DB-verified bound — named as an approximation, not oversold.

## `npm test`: 132 → 156 (+24)

4 reconciliation-worker tests, 2 hold-rate-limit tests, 9 webhook-signature/status-mapping unit tests, 9
new merchant-api integration tests (`/slots` × 4, `/webhooks/razorpay` × 5). Ran the full suite three
times across this session — clean every time. `npx tsc --noEmit` (root) and `npx tsc -b` + `npm run
build` (web) both clean.

## Carried forward

1. **Live verification of the deployed webhook/reconciliation path** — recorded below, once the deploy
   this commit triggers has actually run.
2. **The `HELD`-booking gap in the periodic reconciliation pass** — named above, not closed this session.
3. Every carry-forward item from dev-logs/013 that this session's scope didn't touch (visual verification
   of the deployed viewer, the `AUDIT_TRAIL_TOKEN` mismatch, the decline/merchant-action beat's deploy
   rehearsal, the stuck-idempotency-claim TTL sweep) is still open.
