# Dev Log 032 — Removing the no-show feature: a market-fit call, not a simplification

**Date:** 31 August 2026
**Trigger:** A cross-session message from the architecture session, itself triggered by the user asking
the right question: *does anyone in India actually charge a no-show fee?* Research done in response
found largely no — a 2026 piece on Indian clinics states plainly that "North American patients usually
face a ₹3,000 cancellation fee tied to their card-on-file, while Indian patients typically do not."
Indian salons and clinics **do** use deposits, forfeited on late cancellation or no-show — including
raising deposit requirements during wedding season. That is the market-native mechanism, and it already
existed in Latch, unbuilt-for, as the cancellation ladder's `hoursBefore: 0` floor tier.

So: `charge_no_show`, the no-show authorisation leg, the eligibility worker, and every no-show-specific
column, field, and route are gone. `session_complete_authorization` — the *other* authorisation leg,
which nothing about this decision touches — is untouched.

---

## What actually got removed

- MCP tool `charge_no_show`, and the app-layer command it called (`src/app/charge-no-show.ts`, deleted).
- Merchant API route `POST /bookings/:bookingId/mark-no-show` and its app-layer command
  (`src/app/mark-no-show.ts`, deleted).
- The no-show-eligibility background worker (`src/app/no-show-eligibility-worker.ts`, deleted) and its
  wiring in `mcp/http.ts` / `worker/background.ts`.
- The no-show leg out of `confirm_with_deposit` — no more `needsNoShowAuth`, no more
  `AUTHORIZATION_HELD` construction, no more `no_show_authorization` pay-link leg on a fresh booking.
  `authorizationIdempotencyKey` narrowed from a two-variant union to just `'session_complete_auth'`.
- Policy fields `noShowFeePaise` / `noShowGraceMinutes`, their pairing validation
  (`NO_SHOW_FIELDS_MUST_BE_PAIRED`) and bounds (`GRACE_MINUTES_OUT_OF_BOUNDS`), the policy editor's
  no-show checkbox and fields, and the `POST /policy` wire schema's two fields.
- `BookingSnapshot`'s no-show-only columns: `authorizationId`, `authorizationAmountPaise`,
  `authorizationExpiresAt`, `authorizationLapsedAt`, `nonAttendanceMarkedAt`, `noShowEligibleMarkedAt`.
  The session-complete leg's four-column mirror (`sessionCompleteAuthorization*`) is untouched — it was
  always a structurally separate set of columns, not a `purpose` flag on the same one.
- Refusal codes `NOT_YET_ELIGIBLE`, `MERCHANT_ACTION_REQUIRED`, `NO_SHOW_FEE_NOT_CONFIGURED` (nothing else
  threw them). `AUTHORIZATION_EXPIRED` also removed — its only producer was `charge_no_show`'s own gate.
- The no-show half of the authorisation-lapse worker — it now sweeps only
  `listConfirmedBookingsWithExpiredSessionCompleteAuthorization`, and
  `listConfirmedBookingsWithExpiredAuthorization` (the EventStore method, the port, and the Postgres
  query behind it) is deleted outright, along with `claimConfirmedBookingsPastStart` /
  `EventStoreTx.claimConfirmedBookingsPastStart`.
- The reconciliation worker's own no-show-authorization check in `detectKnownReferenceMismatches` — the
  deposit check stays, the authorisation check (which only ever looked at the no-show leg) is gone.
- Migration `0017_remove_no_show.sql`: drops `policies.no_show_fee_paise` / `no_show_grace_minutes` and
  `bookings.authorization_id` / `authorization_amount_paise` / `authorization_expires_at` /
  `authorization_lapsed_at` / `non_attendance_marked_at` / `no_show_eligible_marked_at`.

## What deliberately did not move

- `session_complete_authorization` and everything under it — `mark_complete`, the merchant-only
  session-complete charge, its own authorisation-lapse sweep, its own reconciliation surface. The task
  was explicit about this and the code already kept the two legs structurally separate (two sets of
  columns, two event types, two authorization-id fields threaded through every handler), so removing one
  never meant touching the other's plumbing.
- The cancellation ladder, `evaluateLadder`, retention/refund math — completely untouched. The floor
  tier (`hoursBefore: 0, retainPct: 100`) is the no-show recovery mechanism now, and it already worked;
  nothing needed building.
- `PENDING` stays a result shape (docs/03-domain-model.md's own invariant); `confirm_with_deposit` now
  offers at most two legs (`deposit`, `session_complete_authorization`) instead of up to three.

## Historical events: the deliberate decision

The `events` table is append-only and is the source of truth. Existing bookings — including ones seeded
or confirmed during this project's own development — may already carry `AUTHORIZATION_HELD`,
`NO_SHOW_ELIGIBLE`, `NON_ATTENDANCE_MARKED`, or `NO_SHOW_CHARGED` events, and one of those bookings'
projected `status` may genuinely be `NO_SHOW_CHARGED` today. Rewriting or deleting any of that would make
the trail lie about what actually happened, which is the one thing this system's audit trail exists to
never do (the same principle migration `0010_policies_immutable.sql` states for policy versions).

So, deliberately:

- **`src/domain/events.ts`** keeps every no-show event type (`AuthorizationHeldEvent`,
  `AuthorizationReleasedEvent`, `AuthorizationLapsedEvent`, `NoShowEligibleEvent`,
  `NonAttendanceMarkedEvent`, `NoShowChargedEvent`) in the `BookingEvent` union, each now carrying a
  doc-comment explaining it is historical-only — no live code path constructs one, but `fold()` must
  keep being able to parse and replay one from a pre-removal booking's own history.
- **`src/domain/event-factory.ts`** drops the five `create*` functions for those types
  (`createAuthorizationHeldEvent` and friends) — nothing should ever be able to construct one of these
  again, which is a stronger guarantee than "nothing currently calls it."
- **`src/domain/fold.ts`**: `BookingStatus` keeps `NO_SHOW_ELIGIBLE` / `NO_SHOW_CHARGED`, and
  `applyEvent`'s switch is untouched — it already handled these cases correctly and still must, for a
  pre-removal booking's replay.
- **`src/adapters/db/schema.ts`**: `eventTypeEnum` and `bookingStatusEnum` keep every no-show-era value.
  Postgres can't cheaply drop a value from an enum a historical row might still reference without
  recreating the type, and there's no benefit to that surgery — keeping them costs nothing.
- **The web viewer** (`EventsTable.tsx`, `totals.ts`, `web/src/types.ts`) is untouched. It already renders
  by event `type` by string match, not by importing the domain's live union — a pre-removal
  `NO_SHOW_CHARGED` event in the trail still renders exactly as it always did.
- **The migration** only drops the `bookings` projection's no-show-only columns, never touches `events`.
  `bookings` is a disposable projection (see `fold.ts`'s own doc comment: "everything here is
  computable by replaying events") — dropping its columns loses no history, since whatever a pre-removal
  booking's own no-show authorisation actually was still lives permanently in that booking's
  `events.payload` rows. The `bookings` rows themselves that still carried live no-show state (from this
  project's own prior test/demo runs) were left alone by the migration; the columns just went away
  under them.

## The one thing that had to keep working: the ceiling-refusal demo

`src/app/demo-ceiling-refusal.ts` used to read `snapshot.authorizationId` / `authorizationAmountPaise` —
the no-show leg's fields — to attempt an over-ceiling capture and show Razorpay refuse it. That beat
(pitch video 2:00–2:45) is the strongest evidence for bar clause B3 ("impossible, not merely caught"):
our own server requests a capture one paisa above the authorised amount, and the rail — not an `if` in
our own code — refuses it.

Repointed at `snapshot.sessionCompleteAuthorizationId` / `sessionCompleteAuthorizationAmountPaise`
instead. Same demonstration, same rail, same zero-headroom ceiling — the session-complete mandate is
authorised at exactly `service.price - deposit` the same way the no-show fee used to be authorised at
exactly itself. Verified live against `FakePaymentRail` (which reproduces `ManualCaptureRail`'s real
behaviour exactly, per its own doc comment):

```
Demonstrating the ceiling refusal against booking bkg_01M1A4WM53CA7E3QXZ42D1H4F3 (rail: manual_capture)...

Authorised amount:    ₹500.00
Attempted capture:    ₹500.01
Refused: "Capture amount 50001 for bkg_01M1A4WM53CA7E3QXZ42D1H4F3 does not equal the amount authorized — the rail refuses any capture that isn't exact"
Mapped to refusal code: CAPTURE_AMOUNT_MISMATCH
Recorded in the trail as ACTION_REFUSED, enforcedBy: payment_rail.
```

**Not verified against real Razorpay test mode.** A fresh booking needs a human to complete Checkout
twice (deposit + session-complete) before the demo can run against it, and this session — like every
prior one that hit this same wall (dev-logs/006/007) — cannot drive a real, non-headless browser through
Razorpay's own bot-resistant card-entry fields. No pre-existing CONFIRMED booking in the dev database
carries a *real* Razorpay session-complete authorisation either (checked directly — every
`sessionCompleteAuthorizationId` currently in the dev DB is a ULID-format id from `FakePaymentRail`, not
a Razorpay-format one). This is the same limitation the project has documented consistently, not a new
gap opened by this change — `ManualCaptureRail`'s own order-creation and unpaid-poll behaviour, which
*can* be driven live, already has `manual-capture-rail.live.integration.test.ts` covering it against the
real API.

## Cost model and docs

`docs/03-domain-model.md`, `docs/01-architecture.md`, `docs/02-tech-stack.md`,
`docs/04-features-and-limitations.md`, `docs/06-build-sequence.md` (the pitch-video script only —
Slice 4/5's own historical section is left as the record of what was actually built then, same as
dev-logs), `docs/07-deployment.md`, and `README.md` all updated to stop describing a feature that no
longer exists, each with a note pointing at this removal where the history matters.

`docs/05-cost-model.md`'s "Recovery A" changed from "no-show charges" (₹400 fee, assumed 50% chargeable,
₹76,800/month) to "deposit retained on no-show" (₹300 deposit, already captured at confirm time, kept
automatically because nobody ever cancels a booking nobody intended to attend — no merchant action, no
second Razorpay fee) — ₹115,200/month, since every no-show that reached `CONFIRMED` already had its
deposit captured by construction. Net recovery to the merchant actually went *up* (≈₹157,700/month vs.
the old ≈₹117,000), because the new mechanism needs no "chargeable" discount and pays no second MDR.
The Razorpay-revenue argument is honestly weaker: the old "no-show charges are 100% incremental" line
is gone (there's no longer a second transaction — a no-show just means the first one, the deposit,
never gets refunded), and the strongest remaining incremental-volume case is Recovery C
(agent-originated bookings), which was already unmodelled upside, not new numbers I invented to fill the
gap.

`prompts/` and `agentic-services-transactability-brief.md` were **not** touched — the former are
historical slice prompts, the latter is dated market research, both the same category of record as
dev-logs.

## Tests

Deleted `charge-no-show.integration.test.ts` outright (its subject no longer exists). Every other test
file that referenced the no-show leg — `agent-trust-boundary`, `background-workers`,
`cancel-booking`, `chaos-payment-outage`, `concurrency-idempotency`, `confirm-with-deposit.fast`,
`decline-booking` (both plain and `.live`), `get-booking`, `finalize-from-webhook`, `hold-rate-limit`,
`reconciliation-worker`, `reschedule-booking`, `set-policy` (both plain and `-retroactivity`),
`merchant-api.integration`, `mcp-e2e.integration`, `fold.test`, `policy-validation.test`,
`fake-catalog-repo.test`, `fake-event-store.test`, `manual-capture-rail.live.integration` — got the
no-show leg edited out of its fixtures and assertions rather than deleted, since each of them is still
proving something real about the session-complete leg, the deposit, or the surrounding gate/refusal
logic.

`fold.test.ts` needed the most care: it still has to prove `fold()` correctly replays a pre-removal
booking's `AUTHORIZATION_HELD → ... → NO_SHOW_CHARGED` history, but `event-factory.ts` no longer exports
factories for those types (deliberately — see above). Added four small local helpers in the test file
itself that hand-construct the historical event shapes directly, with a comment explaining why they're
not routed through a shared factory: these events are frozen historical shapes now, not something new
code paths produce, so a test-only, non-exported constructor is the right amount of ceremony, not a
shortcut.

`npm test`: 40 files, **262 tests**, all green — down from 282/282 (dev-logs/031's own count going into
this session). The 20-test drop is entirely no-show-specific coverage removed along with the feature
(the deleted `charge-no-show.integration.test.ts` file plus individual no-show cases pruned out of the
files listed above); no new tests were added, since nothing new was built.

Also applied migration `0017` against the real (port-5433) test Postgres cluster and reran the full
suite after — still 262/262 green, and a direct `information_schema.columns` query confirms the six
no-show-only `bookings` columns are gone while all four `session_complete_authorization_*` columns and
every `policies` column except the two no-show ones survive untouched.

## Two stale-row cleanups, unrelated to the removal itself

`finalize-from-webhook.integration.test.ts` failed twice on unrelated grounds: a prior interrupted test
run had left two `CONFIRMED` bookings sitting on `prac_dr_rao` at the exact slot times
(`2026-09-19T07:00`/`08:00`) this test's own `slotAt('12:30')`/`slotAt('13:30')` helpers happened to
collide with under the partial-unique-index gate — `hold_slot` refused with a genuine `SLOT_TAKEN`-shaped
error before the test's own logic ever ran. Deleted the two stale rows (and their event rows) directly
from the test database; not a code bug, just leftover state from an earlier interrupted run in this same
session.

## What a merchant sees differently now

- `get_policy` / the policy editor no longer offer a no-show fee or grace period at all.
- `confirm_with_deposit` offers at most two pay-link legs instead of up to three.
- The merchant API has one fewer route (`mark-no-show`, gone); `mark-complete` is unchanged.
- A booking whose patient never shows up and is never cancelled or completed just sits `CONFIRMED`
  forever, with its deposit already collected and never refunded — no eligibility marker, no charge
  event, no merchant action required. That is now the entire no-show story, and it matches what an
  Indian merchant actually does today.
