# Dev Log 020 — observability, phase 4: a circuit breaker for money-moving calls

**Date:** 28 August 2026
**Phase:** Fourth item in the stated priority order (dev-logs/017): Pino logging → Prometheus metrics →
error context → **circuit breaker** → idempotency cleanup → graceful shutdown. The user's own prompt
flagged this one explicitly: *"check what already exists first."*
**Status:** Built and tested. `npm test`: 212/212 passing (4 new tests — one in `circuit-breaker.test.ts`,
three in the new `payment-circuit-breaker.test.ts` — plus both live-Razorpay suites, which now exercise
`captureDeposit`/`authorize` running through the breaker against the real API and confirm the closed-state
path is fully transparent). `npx tsc --noEmit` clean.

---

## What already existed — and why it doesn't cover this

`src/app/circuit-breaker.ts` predates this session (dev-logs/016): a real, tested three-state
closed/open/half-open `CircuitBreaker`, wired into `deps.reconciliationCircuitBreaker` and used by the
reconciliation worker's own outbound `fetchPaymentStatus`/`fetchAuthorizationStatus` lookups. The
mechanism the spec's Phase 2.2 asked for — "if Razorpay is down, every `confirm_with_deposit` call times
out, cascading into MCP-side timeouts" — was **not** covered by that: `reconciliationCircuitBreaker` only
guards a periodic background worker's read-only checks, never the customer-facing money-moving calls
(`captureDeposit`, `authorize`, `captureAuthorization`, `refundDeposit`) `confirm_with_deposit`/
`charge_no_show`/`decline_booking`/`cancel_booking`/`mark_session_complete` actually make. Those still ran
completely unguarded — a real outage would mean every one of those calls hanging for the full
`DEFAULT_CAPTURE_TIMEOUT_MS` (5 minutes) individually, exactly the problem named.

## The one correctness issue that shaped the design

A circuit breaker's `execute()` treats any thrown error as a failure by default. Naively wrapping
`captureDeposit`/`authorize` in the *existing* breaker class would count `PaymentDeclinedError` (a
customer's card was declined) and `PaymentTimeoutError` (nobody completed Checkout in time) — both
ordinary, expected business outcomes these calls are contractually allowed to throw — the same as "Razorpay
itself is failing." A short run of ordinary customer declines would trip the breaker and start rejecting
*every* real customer, which is a worse outcome than the problem being solved. `charge_no_show`'s
`CaptureAmountMismatchError` and `AuthorizationNotFoundError` are the same category: gate refusals, not
infrastructure failures.

**Fix:** `CircuitBreaker.execute` gained an optional second parameter, `{ isFailure?: (err) => boolean }`
(default: every rejection counts, unchanged for `reconciliation.ts`'s existing calls, which never pass
it — every error `fetchPaymentStatus`/`fetchAuthorizationStatus` throws already means "the provider call
itself failed"). `src/app/payment-circuit-breaker.ts`'s `executePaymentCall(breaker, fn)` is the one place
that predicate is defined: only `PaymentProviderError`/`PaymentRailError` — "the call to the provider
itself failed unexpectedly," the same distinction those two classes already existed to make — count toward
the streak. Every money-moving call site now goes through this helper, never `.execute` directly, so the
predicate can't be forgotten or copy-pasted differently at one of the five call sites.

## `AppDeps.paymentCircuitBreaker` — a second, separate instance

Not shared with `reconciliationCircuitBreaker`. Reconciliation's read-only lookups and confirm/charge/
decline/cancel's writes are different failure domains; sharing one breaker would mean a spike of read-side
failures (say, a reconciliation-specific bug) could start rejecting real customer payments for an unrelated
reason, or vice versa. Same tuning as reconciliation's own (3 consecutive genuine provider failures, 2
minute cooldown, one half-open probe) — a reasonable default to reuse rather than invent new numbers
without a stronger reason to diverge.

## Where it's wired

Six call sites across five app-layer handlers, each a mechanical wrap (`deps.paymentProvider.captureDeposit
({...})` → `executePaymentCall(deps.paymentCircuitBreaker, () => deps.paymentProvider.captureDeposit
({...}))`), no control-flow change: `confirm-with-deposit.ts` (the deposit capture, both `authorize` calls,
run inside the existing `Promise.all`), `charge-no-show.ts`, `decline-booking.ts`, `cancel-booking.ts`,
`mark-session-complete.ts`. Existing `catch` blocks for domain-specific errors
(`CaptureAmountMismatchError`, `NoDepositFoundError`) are unaffected — `executePaymentCall` only adds
breaker bookkeeping around the call, it never changes what's thrown.

**When open:** a money-moving call now fails in milliseconds with `CircuitOpenError` instead of hanging for
minutes. That error isn't caught specially anywhere new — it propagates the same way any other unexpected
error from these calls already did, into `mcp/server.ts`'s `withToolLogging` (an `error`-status tool
outcome, logged with full detail) or the new `setErrorHandler` safety net (dev-logs/019) for a merchant-api
route. No new refusal code or response shape was invented for it — the existing "unexpected error, logged,
safe generic response" path was already the right one.
