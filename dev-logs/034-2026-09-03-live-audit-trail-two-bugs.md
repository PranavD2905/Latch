# Dev Log 034 — Reading the live audit trail found two more bugs

**Date:** 3 September 2026
**Phase:** Post-Slice-7 hardening, triggered by the user's own live usage of the deployed MCP endpoint
(`latch-mcp-production.up.railway.app`), not a scripted test run.
**Status:** Both bugs fixed and tested. `npm test`: 284/284 green. **Not yet deployed** — committed
(`5e45d8c`, `949e978`) and pushed to `main`, but `npm run deploy` has not been run (docs/07-deployment.md:
pushing to `main` does not auto-deploy).

---

## Why this entry exists

The user hit a confusing `HOLD_EXPIRED` refusal on a booking they'd just paid for via the payment link,
then separately asked to look at the live audit trail after seeing repeated `RECONCILIATION_MISMATCH`
entries. Neither bug showed up in `npm test` beforehand — both are races between the agent's own
`confirm_with_deposit` call and the webhook-driven finalize path dev-logs/031 built, which nothing had
exercised together this way before. Diagnosed entirely from evidence already available without deploying
anything new: `railway logs` against the three live services, the actual event trail the deployed viewer
renders, and the gate/webhook code itself — not guesswork.

---

## Bug 1 — a paid booking got cancelled because of a stale `HOLD_EXPIRED`

### Symptom

Booking `bkg_01M1HVV9TYAEQ2Z964V0EBPEDV`: `confirm_with_deposit` returned `PENDING` with a pay link; the
customer paid both legs through it; 24 seconds later the agent's own retry (same idempotency key, checking
on it) was refused `HOLD_EXPIRED`; two minutes after that the agent cancelled the booking — which
succeeded, and issued a real refund, because the booking actually *was* `CONFIRMED` by then.

### Root cause

`confirm_with_deposit` returns `PENDING` without caching an idempotency result (`confirm-with-deposit.ts`,
`else` branch — "PENDING is not a cacheable terminal outcome"), so a same-key retry re-runs the gate from
scratch rather than replaying anything. In between, Razorpay's `payment.captured`/`payment.authorized`
webhooks landed and `finalize-from-webhook.ts` (dev-logs/031) confirmed the booking — under its *own*
idempotency key (`webhook_finalize_<bookingId>`), which the agent's retry never sees. The retry's gate
check (`snapshot.status === 'HELD' && ...`) then found `status === 'CONFIRMED'`, and the gate's only
response to "no live hold" was one refusal code, `HOLD_EXPIRED` — reused here for "already confirmed by
someone else" even though the reason string underneath literally said `status=CONFIRMED`, not "expired."
The refusal read as failure to the agent, which is what drove the cancel.

### Fix

The gate now distinguishes the two cases: `status !== 'HELD'` because it's genuinely `CONFIRMED` returns a
new `already_confirmed` outcome instead of falling into `refuse('HOLD_EXPIRED', ...)`. That outcome
reconstructs the settled `CONFIRMED` result — `BookingSnapshot` itself has no projected deposit field, so
the deposit is read off the trail's own `DEPOSIT_CAPTURED` event, same place `cancel-booking.ts` reads it
from — and returns it exactly as if this call had confirmed it. Falling into the normal `CONFIRMED` path in
the outer `confirmWithDeposit` wrapper also caches it under the agent's *own* idempotency key, so a third
retry with the same key now gets a clean idempotent replay instead of hitting the gate again at all.

New fast test in `confirm-with-deposit.fast.test.ts` reproduces the exact live sequence — `PENDING`, then a
different-key finalize (simulating the webhook), then a same-key retry — and was confirmed to fail against
the pre-fix code with the identical error the live logs showed
(`booking ... has no live, unexpired hold (status=CONFIRMED)`).

---

## Bug 2 — a fully-recorded payment got flagged as unrecorded

### Symptom

The live viewer showed, for a booking that confirmed correctly in the same instant
(`DEPOSIT_CAPTURED` → `SESSION_COMPLETE_AUTHORIZATION_HELD` → `BOOKING_CONFIRMED`, all at the same
timestamp): a `RECONCILIATION_MISMATCH` — `unrecorded_payment: trail said not_recorded, Razorpay says
authorized (via webhook)` — for a payment that was, in fact, sitting right there in the trail.

### Root cause

`reconciliation.ts`'s `isRecordedAnywhere` — the check that decides whether a webhook's observed payment
is already accounted for — matched `DEPOSIT_CAPTURED`, `NO_SHOW_CHARGED`, and `AUTHORIZATION_HELD`, but
never `SESSION_COMPLETE_AUTHORIZATION_HELD`. `AUTHORIZATION_HELD` is the no-show leg's event type,
historical-only since that feature's removal (dev-logs/032) — no live booking can produce one anymore.
`SESSION_COMPLETE_AUTHORIZATION_HELD` is the type every live booking's session-complete mandate actually
uses, and this function had never been taught to look for it. A `payment.authorized` webhook arriving (or
redelivering) after the booking's own finalize had already recorded it — and cleared `pendingPaymentLegs`,
so the "still outstanding, forgive it" branch didn't apply either — found nothing this function recognised
and fell through to logging a false `RECONCILIATION_MISMATCH`.

### Fix

Added the missing `SESSION_COMPLETE_AUTHORIZATION_HELD` check to `isRecordedAnywhere`, matching on
`authorizationId` the same way `AUTHORIZATION_HELD` already does. New fast test file
(`reconciliation.fast.test.ts`) drives a real booking to `CONFIRMED` via the fakes, then calls
`reconcileObservedPayment` directly with the session-complete leg's own `authorizationId` and `status:
'authorized'` — confirmed to fail against the pre-fix code (`expected true to be false`) and pass now.

---

## What these two bugs have in common

Both are the same shape: `finalize-from-webhook.ts` (dev-logs/031) intentionally lets a webhook finalize a
booking independently of the agent's own `confirm_with_deposit` call, to close the "customer paid but never
told the agent" gap. That's correct and necessary — but it means two different code paths (the agent's
retry, and reconciliation's webhook handler) can now observe a booking or a payment *after* it was already
settled by the other path, and both of them had an incomplete idea of what "already settled" looks like —
one didn't recognise `CONFIRMED` as anything but "no hold," the other didn't recognise
`SESSION_COMPLETE_AUTHORIZATION_HELD` as a recorded authorization at all. Neither gap was visible in any
test written before the webhook-finalize path existed, because nothing exercised the retry/webhook race
together until real usage did.

## Carried forward

- **Not deployed.** Both fixes are on `main` (`5e45d8c`, `949e978`) but `npm run deploy` has not been run —
  the two live bookings this affected were diagnosed after the fact, not fixed in place.
- **The two live-production bookings themselves are untouched.** `bkg_01M1HVV9TYAEQ2Z964V0EBPEDV`'s
  wrongful cancel+refund and `bkg_01M1HVM7FD0SY2XG2CH2V8PRWA`'s lapsed hold (customer opened the pay link,
  never completed it, server-side there's nothing recording why) both stand as-is; this entry only prevents
  the pattern going forward.
- **The local test Postgres cluster (port 5433) needed a manual `pg_ctl start`** — provisioned in an
  earlier session per docs/07-deployment.md's own instructions, but not running by default on a fresh shell.
  Not a new gap, just re-hit.
- **Whether any other reconciliation/webhook code path has the same "which event types count as recorded"
  gap was not audited beyond this one function.** `isRecordedAnywhere` is the only place this exact check
  lives, but worth keeping in mind if a new money-event type is ever added without updating it.
