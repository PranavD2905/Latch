# Dev Log 015 — `set_policy` write path and the policy editor: making retroactivity demonstrable

**Date:** 25 August 2026
**Phase:** New scope, reinstated from `docs/04-features-and-limitations.md` §3 cut item #1 (merchant
policy editor UI) once the schedule allowed it — handed over from the architecture session by
cross-session message, not a `prompts/slice-N.md` file.
**Status:** Done. `npm test` green (193/193, up from 156), run twice with no flakiness observed. The
retroactivity demo works end to end and is pinned by an integration test, not just asserted in docs.

---

## What this closes

`docs/03-domain-model.md` §2 has always claimed: *"A booking made under ladder v4 must be cancelled
under ladder v4, even if the merchant has since published v5."* Every money event has carried
`authority.policyVersion` since Slice 1, and `cancel_booking`/`reschedule_booking` have always looked up
`CatalogRepo.getPolicyVersion(merchantId, snapshot.policyVersion)` rather than the merchant's *current*
policy. All of that machinery already existed and was already tested against a single, static seeded
policy row. What never existed was a way to publish a *second* version — so the claim had no way to be
wrong, which also means it had no way to be demonstrated. This session builds the missing half.

## What was built

1. **`src/domain/policy-validation.ts`** — `validatePolicyInput`, the money-rule gate `set_policy` runs
   before writing anything: ladder strictly descending by `hoursBefore`, `retainPct` in 0–100 and
   non-decreasing as `hoursBefore` decreases (closes the "wait it out, pay less" dodge), a mandatory
   `hoursBefore: 0` floor tier, positive-integer paise amounts, and sane bounds on TTL/grace/limits
   (`POLICY_BOUNDS`, named as this task's own judgement call — nothing in the docs pins these numbers
   down). 20 unit tests, one per rule plus the boundary cases (equal-retention is allowed; strictly
   below is not).
2. **`src/app/set-policy.ts`** — `setPolicy`. `SetPolicyCommand` (aliased to a new `PolicyDraft` domain
   type) has no version field at all, so "the server derives the version" is structural, not a
   convention someone could forget to honour.
3. **`CatalogRepo.publishPolicy`** (`src/ports/catalog-repo.ts` / `src/adapters/db/postgres-catalog-repo.ts`)
   — an INSERT, never an UPDATE. `newVersion = currentActiveVersion + 1` is computed from a plain read,
   then the insert is attempted directly — no lock, no check-then-insert. `policies_merchant_version_unique`
   is the actual arbiter of a race, exactly the same shape `hold_slot` already uses against
   `one_live_booking_per_slot` (`isUniqueViolation`, reused verbatim). A caught violation becomes
   `PolicyVersionConflictError`, a new port-level error type living alongside `CaptureAmountMismatchError`'s
   own precedent.
4. **`GET`/`POST /policy`** on the merchant API (`src/adapters/merchant-api/server.ts`) — same
   bearer-token `onRequest` hook as `decline`/`mark-no-show`, not a new auth scheme. Fastify's JSON
   schema only checks shape; every actual money-rule check is `validatePolicyInput`'s job, so it's
   identical no matter what calls `setPolicy`.
5. **`@fastify/cors`** on the merchant API — new, and the one piece of this task that isn't just "wire up
   an existing pattern." The policy editor lives in the web viewer, which in production is a *different*
   Railway service from the merchant API (`docs/07-deployment.md`'s three-service topology) — genuinely
   cross-origin, unlike the SSE feed's same-origin design. CORS only governs which origins JS can *read*
   a response; the Bearer-token hook is still the actual authorization, so reflecting the caller's Origin
   doesn't loosen who can act.
6. **The policy editor** (`web/src/PolicyEditor.tsx`, `policyApi.ts`, `policyTypes.ts`) — a new "Policy"
   tab in the existing viewer. Shows the active version prominently, requires a two-step confirm to
   publish ("Publish as v5" → a confirmation panel naming exactly what publishing does and doesn't do →
   "Confirm — publish v5"), and — per the brief's own suggested item 6 — a computed-consequence callout:
   deposit-forfeited-plus-no-show-fee summed live as the draft changes, with an explicit note that this
   total is not something Latch asserts is correct, just something it now makes visible. Charging
   behaviour is unchanged; only visibility changed.

## The design decision that mattered most: an isolated merchant per token, at the browser layer

`AppDeps.merchantId` is a single fixed value (this project is deliberately not multi-tenant,
`docs/01-architecture.md` §10) — there's exactly one merchant's policy the editor can ever talk to,
whichever one the deployed merchant API's `.env` points at. The interesting design question wasn't
multi-tenancy; it was **where the merchant's credential lives**. `VITE_AUDIT_TRAIL_TOKEN` is baked into
the viewer's static bundle at build time — fine for a read-only SSE token, but doing the same for a
token that can publish money rules would mean shipping a write credential to every browser that loads
the page. Instead: `VITE_MERCHANT_API_URL` (a public base URL, not a secret) is the only thing baked in;
the merchant's actual bearer token is entered into the editor at runtime and kept only in that browser
tab's `sessionStorage`. This is the first genuinely write-capable surface in the viewer — worth getting
right precisely because it's the first one.

## A real bug the concurrency test caught, not assumed away

The first draft of the concurrent-double-publish test asserted "exactly one of N concurrent calls
succeeds, the other N−1 are refused." Running it against real Postgres immediately falsified that: with
8 concurrent `setPolicy` calls and a pooled connection (`DB_POOL_MAX=5`), 2 of them fully completed
(read + insert) before the others even started their read — a perfectly legitimate sequential publish,
not a race, and each landed on a distinct, correct version. The actual invariant `set_policy` needs to
guarantee is narrower and more useful: **no two concurrent publishes ever produce the same version
number**, not "at most one caller can ever win." Rewrote the test to assert that instead — the winning
versions, sorted, must be exactly the contiguous run `startVersion+1 .. startVersion+winnerCount`, with
every loser rejecting as `PolicyVersionConflictError`. This is a stronger, more honest claim than the
original assumption, and it's the one the system actually makes.

## The retroactivity demo, end to end

`src/app/set-policy-retroactivity.integration.test.ts` is the test this whole task exists to make
possible:

1. Reads whatever policy version is currently active for the seed merchant (never hardcodes "v4" — this
   repo's own convention, dev-logs/013, is that several Claude Code sessions can share one local Postgres
   at once, so the seed's exact current version shouldn't be assumed).
2. Books and confirms a real booking under that version.
3. Publishes a new version with a **deliberately different** ladder — one that retains 100% at every
   `hoursUntil`, specifically so the two versions are distinguishable at the cancel instant this test
   uses, not coincidentally identical.
4. Confirms `get_policy` now returns the new version (new bookings would cite it).
5. Cancels the *original* booking. The retained/refunded amounts match what the *original* ladder would
   produce at that instant — not the new one's "always retain everything" — and the assertion explicitly
   checks the amounts differ from what the new policy would have produced, so the test can't pass by
   coincidence.
6. Reads the booking's own event history and confirms `RETENTION_APPLIED`/`REFUND_ISSUED`'s
   `authority.policyVersion` still cites the original version.

Every new policy row this test (and `set-policy.integration.test.ts`) creates is deleted in `afterAll` —
publishing is permanent by design, but a test fixture isn't a real merchant, and this repo's own
concurrent-session convention means leaving a stray v5 on `mer_clinic` would corrupt an unrelated test
run or another session's demo. `set-policy.integration.test.ts`'s other five tests run against an
isolated `mer_test_setpolicy_*` merchant created just for the file, specifically so they never touch
`mer_clinic`'s active version at all.

## Trust-boundary test updated, not just re-passed

`src/app/agent-trust-boundary.integration.test.ts` had a test literally titled "no live route — agent-facing
or merchant-authenticated — can set the merchant policy," asserting `POST /policy` 404s even with a valid
token. That assertion is now false by design, so it was rewritten rather than deleted: the trust-table
claim survives in a narrower, still-real form — the route exists, but still has no agent-facing path to
it (same MCP-tool-list absence as `decline`/`mark_no_show`) and still 401s without the merchant's own
token, a credential no agent is ever issued.

## What the docs didn't settle (now recorded)

- **Whether the deposit and the no-show fee should compound** — the brief itself flagged this as an open
  design question. Not resolved here: charging behaviour is unchanged, and the editor's consequence
  callout says so explicitly rather than implying the total it displays is a considered figure.
- **CORS on the merchant API is new attack surface, mitigated by staying additive.** It doesn't loosen
  the actual bearer-token check; it only changes which origins can *read* an already-gated response.
- **The isolated-test-merchant pattern** used by both new integration test files is worth reusing for any
  future write path that needs real concurrency testing without perturbing `mer_clinic`'s shared state.

## `npm test`: 156 → 193 (+37)

20 policy-validation unit tests, 6 `set-policy` integration tests (version-1-from-nothing, INSERT-not-UPDATE
proven both structurally and functionally, smuggled-version ignored, validation-failure-leaves-no-trace,
concurrent-publish-no-duplicates), 1 retroactivity integration test, 10 merchant-api `/policy` integration
tests. `agent-trust-boundary.integration.test.ts` kept at 3 (one test rewritten in place, not added). Ran
the full suite twice — clean both times.

## Carried forward

- Every carried-forward item from dev-logs/013/014 this session's scope didn't touch (visual verification
  of the deployed viewer, the `AUDIT_TRAIL_TOKEN` mismatch, the stuck-idempotency-claim TTL sweep, the
  periodic reconciliation pass's `HELD`-booking gap).
- **Visual browser verification of the policy editor specifically wasn't possible this session either** —
  same `tabs_context_mcp` "Browser extension is not connected" gap dev-logs 011/012/013 already
  flagged, still open. Verified the exact HTTP contract the UI depends on instead: started a real
  `merchant-api` instance and a real Vite dev server pointed at it, then drove `GET /policy`, an invalid
  `POST /policy` (422 with the specific code), and a valid `POST /policy` with a browser `Origin` header
  present (confirming `access-control-allow-origin` actually reflects it) via curl. That manual publish
  landed a real v5 on `mer_clinic` — caught immediately and deleted before moving on, restoring the active
  version to v4. Someone with a connected Chrome extension should still click through the editor once
  before recording.
