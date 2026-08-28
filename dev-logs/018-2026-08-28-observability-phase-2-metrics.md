# Dev Log 018 — observability, phase 2: Prometheus metrics

**Date:** 28 August 2026
**Phase:** Second item in the stated priority order (dev-logs/017): Pino logging → **Prometheus metrics**
→ error context → circuit breaker → idempotency cleanup → graceful shutdown.
**Status:** Built and tested. `npm test`: 208/208 passing (including the live Razorpay integration tests,
which now exercise the instrumented client). `npx tsc --noEmit` clean. Verified live: called two tools
against a running `latch-mcp` and confirmed `GET /metrics` renders both the counter and histogram series
with the right labels and observed values.

---

## The four problems actually named

The originating spec's own justification for this phase named four concrete blind spots: *"No way to know
how many holds are succeeding vs failing; p99 latency of `confirm_with_deposit`; how often the rate
limiter triggers; spikes in Razorpay failures."* Everything built this session maps directly to one of
those four — nothing more was added speculatively.

## `src/adapters/observability/metrics.ts`

One process-wide `prom-client` `Registry`, plus `collectDefaultMetrics` (free CPU/memory/event-loop-lag
signal). No `Metrics` port was added alongside `Logger`'s — nothing in `src/app/*.ts` needs to record a
metric directly in this scope; every instrumentation point below lives in `src/adapters/`, so a port
abstraction would have been indirection with no caller on the other side of it.

**One counter + one histogram, labeled by `tool`, instead of 5 near-duplicate per-tool metrics.** The spec
asked for `latch_hold_slot_total`, `latch_confirm_with_deposit_total`, `latch_charge_no_show_total`,
`latch_cancel_booking_total` as separate counters (plus separate duration histograms for two of them) —
structurally identical series, differing only in which tool fired. `latch_tool_invocations_total{tool,
status, code}` and `latch_tool_duration_ms{tool, status}` are the same information via a label dimension
instead of a name, which is the standard Prometheus answer to "many identically-shaped counters." `code`
carries the `RefusalCode` on a refusal or the thrown error's constructor name on a genuine error — both
bounded, statically-defined sets, so this doesn't reopen the cardinality risk the cross-session brief
flagged for merchant/agent-keyed labels.

**`instrumentRazorpayClient`** — a `Proxy` wrapped around the `Razorpay` SDK client once, at construction,
in both `RazorpayPaymentProvider` and `ManualCaptureRail`. Every `client.<resource>.<method>(...)` call
(`orders.create`, `orders.all`, `orders.fetchPayments`, `payments.fetch`, `payments.refund`,
`payments.capture`, `payments.fetchMultipleRefund` — 14 call sites across the two files) is timed and
counted transparently, labeled `${resource}.${method}` (e.g. `payments.capture`), without touching any of
those call sites individually or changing what they throw. This is also what makes the spec's separate
`latch_razorpay_capture_duration_ms` unnecessary — `latch_razorpay_api_call_duration_ms{method=
"payments.capture"}` is that exact series, selected by label. Verified against the real API. not just the
fakes: `manual-capture-rail.live.integration.test.ts` and `razorpay-payment-provider.live.integration.test.ts`
both still pass, meaning the wrapped client's real Checkout-polling behaviour is unchanged.

**`latch_mcp_rate_limit_triggered_total`** — incremented inside `streamable-http-server.ts`'s existing
`@fastify/rate-limit` `errorResponseBuilder`, the exact point that already fires once per 429. Kept
separate from `latch_tool_invocations_total{code="RATE_LIMITED"}` on purpose: that label is the
*business* ceiling (`policy.holdRateLimitPerMinute`) refusing inside a completed tool call; this counter
is the *transport*-level DoS throttle rejecting a request before it ever reaches a tool handler — same
name, different problem, so they stay distinguishable in a dashboard rather than silently merged.

**`registerMetricsRoute(app)`** — `GET /metrics` mounted on all four Fastify servers (`mcp`, `merchant-api`,
`audit-trail`, `rest`). Unauthenticated, the same posture `/healthz` already has and for the same
documented reason (no scrape-auth mechanism exists in this deployment yet) — a deliberate, named
trade-off, not an oversight. `merchant-api/server.ts`'s `isPublicRoute` gained `/metrics` alongside
`/healthz`/`/slots`/`/webhooks/razorpay`, or the bearer-token `onRequest` hook would have 401'd Prometheus
before the route ever ran.

## Deliberately not built this pass

- **`latch_concurrent_holds_per_agent`/`latch_active_merchants` gauges.** Both are point-in-time
  aggregates with no existing query to source them from (`countLiveHoldsForAgent` is per-agent, not "top
  10"). Building a new aggregate SQL query for a nice-to-have gauge, versus reusing something that already
  existed the way every other item this pass touched did, felt like scope creep against the four named
  problems above, none of which needed it.
- **`payment_method` label.** Nothing in this codebase currently distinguishes deposit captures by method
  at the point a metric would be recorded — added the day that dimension is real, not before.
- **`latch_db_query_duration_ms`.** Would mean touching every Postgres call site across
  `postgres-event-store.ts`/`postgres-catalog-repo.ts`/etc., for a problem none of the four named pain
  points actually named.
- **`GET /metrics` on the three standalone worker entrypoints** (`worker/background.ts`,
  `worker/authorization-lapse.ts`, `worker/reconciliation.ts`) — none of them run a Fastify instance today.
  Their activity is still visible: it's folded into `mcp/http.ts`'s in-process copy of the same workers,
  which does expose `/metrics`, in production (docs/07-deployment.md's own topology).
- **Merchant-api route-level invocation counters** (`decline_booking`, `mark_no_show`,
  `mark_session_complete`, `set_policy`) — not MCP tools, not named in the four problems. Razorpay-call
  visibility already covers what those routes do that actually touches an external system.
