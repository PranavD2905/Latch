# Dev Log 019 — observability, phase 3: error context

**Date:** 28 August 2026
**Phase:** Third item in the stated priority order (dev-logs/017): Pino logging → Prometheus metrics →
**error context** → circuit breaker → idempotency cleanup → graceful shutdown.
**Status:** Built and tested. `npm test`: 208/208 passing (including both live-Razorpay suites, which
exercise the enriched error classes and the refactored `parseRazorpaySdkError` through the real SDK).
`npx tsc --noEmit` clean. Verified live: a malformed-JSON request logged the full error server-side
(`traceId`, `path`, `method`, `statusCode`, the original `SyntaxError` and its stack) while the client
response stayed a safe `{"error":"internal server error","traceId":"..."}` — no internal detail leaked.

---

## What the spec asked for vs. what this codebase already had

The spec's `ErrorContext` class proposal (`new ErrorContext({}).add('bookingId', ...).add(...)`) turned
out to duplicate a fluent-builder pattern Pino already provides better: `deps.logger.child({ bookingId,
merchantId })` is the same idea, already wired up (dev-logs/017), already flows through everywhere a
request-scoped logger exists. Adding a second, parallel context-builder class would have meant two ways
to attach the same kind of field, not one gap closed — skipped for that reason, not overlooked.

What *was* a real gap: `PaymentProviderError`/`PaymentRailError` (`src/ports/payment-provider.ts`,
`src/ports/payment-rail.ts`) already wrapped Razorpay SDK errors and already preserved the raw error as
`.cause` — but only the *message string* it built (`Unexpected payment provider error for ${reference}:
${describeCause(cause)}`) carried the useful detail. A structured logger receiving `{ err }` had no
queryable `bookingId`/error-code field to filter or group on, only a string to grep.

## What was built

**`reference`/`providerErrorCode`/`providerErrorDescription`** — added as real own properties on both
error classes, not just folded into the message. Named `reference` rather than `bookingId`: every throw
site except one passes a bookingId, but `fetchPaymentStatus`/`fetchAuthorizationStatus`'s failure path
passes the `paymentId`/`authorizationId` it was looking up instead — `bookingId` would have been wrong at
exactly that call site, so the property stays named after what the port's own constructor parameter has
always been called. This matters for logging, not just precision: Pino's `err` serializer copies an
error's own enumerable properties automatically, so `deps.logger.error({ err }, ...)` — which
`mcp/server.ts`'s `withToolLogging` (dev-logs/017) already does for every uncaught tool error — now emits
these fields as flat, queryable log fields with zero additional code at any call site.

**`providerErrorCode`/`providerErrorDescription` stay provider-agnostic at the port level.** The two
`*ErrorDetails` interfaces (`{ code?, description? }`) live in `src/ports/`, with no Razorpay-specific
naming or import — `PaymentProvider`/`PaymentRail` must stay implementable by `FakePaymentProvider`/
`FakePaymentRail` too. The Razorpay-specific parsing lives where it already belonged, in
`src/adapters/payment/razorpay-shared.ts`'s new `parseRazorpaySdkError`, which both real adapters now pass
as the error classes' third, optional constructor argument at each of their ~14 SDK call sites (mechanical:
append `, parseRazorpaySdkError(err)`; nothing about control flow changed). This also let two
near-duplicate local helpers collapse into the one shared parser: `manual-capture-rail.ts`'s own
`razorpayErrorDescription` is gone, and `razorpay-shared.ts`'s existing `isNotFound` now calls the same
parser instead of its own inline shape-narrowing.

**No second explicit "log before rethrowing" call was added inside the adapter classes themselves** — the
spec's literal ask, but doing it would mean threading a `Logger` into `RazorpayPaymentProvider`/
`ManualCaptureRail`'s constructors, which don't have request-scoped context (`bookingId`'s already in the
error; `merchantId`/`agentId` aren't) to add over what the *caller* can already log. Every real call path
already logs the propagated error with full context at the point that actually has it: `mcp/server.ts`'s
`withToolLogging` for every MCP tool, and the new `setErrorHandler` below for anything a merchant-api route
lets propagate past its own specific catches.

**`registerErrorHandler(app)`** (`src/adapters/observability/fastify-logging.ts`) — a Fastify
`setErrorHandler`, registered on all four servers alongside `echoTraceIdHeader`. This is a safety net, not
the primary error path: every route that can fail in an expected way already catches its own specific
error types (`BookingNotFoundError`, `PolicyValidationError`, `Refusal`, ...) and picks its own status
code — this only fires for what those don't catch (a bug, a DB outage, an enriched
`PaymentProviderError`/`PaymentRailError` that propagated unhandled). Logs
`{ err, path, method, statusCode }` — `traceId` isn't duplicated into the fields since `request.log`
already carries it as a bound field (dev-logs/017) — and responds `{ error, traceId, code }`. A genuine
5xx never echoes the internal exception message to the client, only `"internal server error"` plus the
trace id to hand back for support; a Fastify-native 4xx (schema validation, an unparseable body) is safe
to echo since that message is already client-facing validation text, not internal detail.
`merchant-api/server.ts`'s `isPublicRoute` did **not** need `/metrics` added again here — that was already
done in dev-logs/018 — but is the reminder that any new unauthenticated route in that file needs both
lists updated, not just one.

**Not applicable to hijacked routes**, same as `echoTraceIdHeader`: the MCP transport and the SSE feed
bypass Fastify's error pipeline entirely once `reply.hijack()` runs, and both already have their own
explicit `catch` blocks (dev-logs/017 added `X-Trace-ID` there for the same reason).
