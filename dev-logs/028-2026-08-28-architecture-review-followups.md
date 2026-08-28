# Dev Log 028 — Architecture review follow-ups

**Date:** 28 August 2026
**Trigger:** An independent architecture review (pulled the repo fresh via GitHub's tarball, verified
typecheck + the pure-domain unit tests independently) named four things to interrogate: the audit-trail
atomicity gap, the no-agent-identity non-goal, `fold()`'s purity crack around the session-complete
authorization legs, and the integration-heavy test coverage skew. Working through each with judgment
rather than implementing every suggestion literally — some of it really is already about as good as it
can reasonably get.

---

## 1. The audit-trail atomicity gap — closed the reachable half of it, not the whole thing

The review's framing ("crash between a Razorpay capture succeeding and the local event landing") is real
but, on inspection, not the sharpest form of the problem. `chaos-payment-outage.integration.test.ts`
(dev-logs/016) had already pinned the actual mechanism: `confirm_with_deposit` ran the deposit capture
and the two optional authorisation legs (no-show fee, session-complete mandate) concurrently via
`Promise.all`. If the deposit succeeded and *either* optional leg failed — an ordinary single-leg network
blip, not a process crash — `Promise.all`'s all-or-nothing rejection discarded the already-settled
deposit result along with the failure. Real money captured, zero trail for it, booking stuck `HELD` until
the hold-expiry worker eventually swept it. dev-logs/016 wrote a test to *prove* this and relied on the
webhook path to recover it after the fact.

That's fixable at the source, and cheaper than the review's implied "widen the periodic scan to `HELD`
bookings" fix — which, on inspection, wouldn't actually work: `detectKnownReferenceMismatches` only checks
a `razorpayId` already recorded in the trail or on the projection, and a booking stuck this way has
neither. There's nothing for a widened scan to check without a receipt-lookup capability this codebase
doesn't have.

**The fix:** `confirm-with-deposit.ts` now uses `Promise.allSettled`. The deposit leg stays mandatory —
its failure still rejects and leaves the booking `HELD` to retry, unchanged. Once it succeeds, the
confirm always proceeds and records whichever optional legs actually landed, logging loudly for any that
didn't. An authorisation that failed to acquire never moved real money, so there's nothing to release —
unlike a captured deposit, there's no orphaned Razorpay object to worry about.

Updated `chaos-payment-outage.integration.test.ts` to prove the fix instead of the gap it used to
document, and added a sibling test pinning that the mandatory-leg-failure path is untouched. Corrected
`04-features-and-limitations.md`'s "widening the periodic scan is a small follow-up" line, which turned
out to be wrong on inspection, and named what's actually true: the residual case is now narrower — a
genuine process crash between the payment call returning and the final transaction committing, which no
in-process `Promise` handling can reach. That residual case is still webhook-and-retries only, and stays
that way; building a formal outbox for it was already evaluated and declined in dev-logs/016 for good
reason (asking the payment provider directly, which the webhook/reconciliation worker already do, is
strictly stronger than a second local write that could itself drift).

## 2. No-agent-identity non-goal — left as a non-goal, sharpened the honest limitations row

Confirmed this is correctly out of scope to build (composing with Web Bot Auth/Visa TAP/NPCI UAP rather
than reinventing agent identity is the right call at this stage), but found the existing "no
merchant-wide hold-rate ceiling" row in `04-features-and-limitations.md` under-stated its own risk.
`agentId` is a caller-supplied, unverified string — a direct consequence of the identity non-goal — so
*one* attacker holding a single valid merchant credential can already defeat every per-agent
hold/concurrency ceiling alone, just by generating a fresh `agentId` per request. dev-logs/016's original
framing assumed many independently-run attackers coordinating, which understated how cheap this actually
is. Sharpened that row rather than building anything: the practical impact is still bounded (a valid
merchant credential is still required, and every request still counts against the flat per-caller-IP
transport rate limit regardless of how many `agentId`s it claims), and building real per-agent identity to
close it fully is exactly the layer the non-goal already defers.

## 3. `fold()`'s purity crack — not a new crack, just an undocumented instance of an existing one

`fold()` treating `SESSION_COMPLETE_AUTHORIZATION_HELD`/`_RELEASED`/`_LAPSED` as no-ops isn't a new
departure from "the fold is the source of truth" — it's the exact same divergence `docs/03-domain-model.md`
already named and accepted for `NO_SHOW_ELIGIBLE` back in Slice 5 (a pure `fold()` reference model, tested
directly by `fold.test.ts`, versus the live Postgres projection every command handler actually reads,
which is a superset of `fold()`'s own state and carries operational fields no replay needs). The
session-complete-charge feature landed without updating that documentation, so the event catalogue table
was missing all four `SESSION_COMPLETE_*` event types entirely and the divergence had no analogous note.
Brought `docs/03-domain-model.md` up to date (added the missing table rows, added a note parallel to the
`NO_SHOW_ELIGIBLE` one) and cross-referenced it from `fold.ts`'s own `BookingState` doc comment, so a
reader hits the explanation from either the domain model doc or the source. No code changed — this was a
documentation-currency gap, not a behavioural one.

## 4. Integration-heavy test coverage — added the missing fakes, not a wholesale rewrite

21 of 32 test files were `.integration.test.ts` because `EventStore`/`IdempotencyStore`/`CatalogRepo` had
no fakes the way `PaymentProvider`/`PaymentRail` already did (`FakePaymentProvider`/`FakePaymentRail`,
existing since Slice 1) — so a command handler's own gate/refusal logic, not the Postgres row-locking
underneath it, could only be exercised through a live database.

Added `FakeEventStore`, `FakeIdempotencyStore`, `FakeCatalogRepo`, and `FakeWebhookDeadLetterStore`
(`src/adapters/db/fake-*.ts`), each with its own unit test, matching the existing fake-adapter pattern
exactly. Deliberately narrow, and documented as such in both the class doc comments and
`docs/02-tech-stack.md` §12: no real row lock, no `FOR UPDATE SKIP LOCKED`, no partial unique index —
`transaction()` on the fake store is a plain function call with no isolation between concurrent callers in
the same process, and `lockAgent` is a documented no-op. Race 1 (`one_live_booking_per_slot`), Race 2
(hold-expiry vs. confirm), and the advisory-lock-guarded background-worker concurrency tests correctly
stay `.integration.test.ts` against the real store — a fake cannot and should not try to reproduce what
they're actually proving.

`confirm-with-deposit.fast.test.ts` demonstrates the pattern: the same gate/refusal coverage
`chaos-payment-outage.integration.test.ts`/`booking-flow.integration.test.ts` already have, plus the
`Promise.allSettled` fix from item 1, reproduced in milliseconds with no Postgres connection, no
`db:migrate`/`db:seed`. Did not convert the existing 21 integration files to the fake — that actually
would have been the "wholesale rewrite" the review's own framing said to avoid, and several of them
(concurrency, background workers, webhook dead-lettering) are exactly the tests that must keep exercising
the real store. This is meant as the reusable seam future sessions extend to more command handlers, one
file at a time, not a one-shot conversion.

## `npm test`: 32 files / ~226 tests → 39 files / 256 tests (+7 files, +30 tests)

4 fake-adapter unit test files (`fake-event-store`, `fake-idempotency-store`, `fake-catalog-repo` — 21
tests total), 1 fast command-handler test file (`confirm-with-deposit.fast.test.ts` — 8 tests), and
`chaos-payment-outage.integration.test.ts` split into two focused tests instead of one. Full suite green,
including the live-Razorpay integration tests.

## An incident, recorded honestly rather than silently worked around

Partway through this session, several just-written files (the four fake adapters, their tests, and one
documentation edit) disappeared from disk between one command and the next, with `git status` reporting a
clean tree at HEAD — not a git operation this session ran (no matching reflog entry), and not anything
this session deleted. The most likely explanation is a concurrent session sharing this same working
directory (this repo's own convention, dev-logs/012, already names this as a known risk with multiple
Claude Code sessions open on one checkout) running a `git checkout`/`clean` against a tree it didn't know
had another session's uncommitted work sitting in it. Recovered by rewriting the lost files from this
session's own conversation content (nothing was lost that wasn't reconstructable) and committing
immediately afterward rather than continuing to batch further uncommitted work. Named here, not hidden,
per this project's own convention for recording things that went sideways — flagged directly to the user
in this session's own reply, since it's a real risk with running multiple local Claude Code sessions
against one working directory without separate worktrees.

## Carried forward

- The residual audit-trail gap named in item 1 (a genuine process crash between the payment call
  returning and the final transaction committing) is still real, still narrow, and still
  webhook-and-retries-only by design — not a something-forgotten item, a deliberately accepted one.
- The fake-adapter seam from item 4 is not yet used by any command handler other than
  `confirm_with_deposit`. Extending it to `hold_slot`'s and `decline_booking`'s own gate/refusal paths is
  a reasonable next slice, not squeezed into this one.
