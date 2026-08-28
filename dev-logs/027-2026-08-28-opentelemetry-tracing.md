# Dev Log 027 — OpenTelemetry tracing, without auto-instrumentation

**Date:** 28 August 2026
**Phase:** Fourth and last of the four lower-priority items (config module → security headers → load
testing → **tracing**), and the final item overall from the original observability/hardening spec
(dev-logs/017-026).
**Status:** Built and verified live. `npm test`: 226/226 passing. `npx tsc --noEmit` clean. Verified
against a real running server with `OTEL_ENABLED=true`: a tool call produces a real exported span
(`name: 'find_slots'`, correct `service.name` resource attribute, `status: { code: 1 }` for OK); a second
run proved a real, non-hypothetical bug — a span created immediately before `SIGTERM` was being silently
dropped — and the fix for it, by calling a tool and sending `SIGTERM` within ~1-2 seconds, well inside
`BatchSpanProcessor`'s ~5s default flush window, and confirming the span still appears in the exported
output before "shutdown complete" logs.

---

## The decision this phase actually turned on

The spec's own version of this asked for `@opentelemetry/auto-instrumentations-node`, patching Postgres
and Fastify automatically. Two things made that the wrong call for this codebase specifically, not just a
generic simplification:

1. **This project's actual DB driver is `postgres` (postgres-js), not `pg`.** There is no first-party
   OpenTelemetry instrumentation for postgres-js in the standard `opentelemetry-js-contrib` set —
   `@opentelemetry/instrumentation-pg` targets an unrelated library. Auto-instrumentation would have
   silently produced *no* database spans at all while looking fully configured.
2. **This is a pure-ESM codebase** (`"type": "module"`, every file). Auto-instrumentation patches a target
   module's `require`/`import` via `require-in-the-middle`/`import-in-the-middle` at load time — for ESM,
   that hook must be registered *before* Node starts evaluating the entry module at all, via a `--import`
   flag on the actual `node`/`tsx` invocation. Achieving that correctly here would mean changing how all
   ~10 npm scripts and Railway's start commands (docs/07-deployment.md) launch every process, and I had no
   way to verify under this exact ESM/tsx/Node-22 combination that it would actually patch anything without
   building and testing that launch-mechanics change end-to-end. Shipping instrumentation that *looks*
   wired but silently isn't is worse than not building it — a team would trust dashboards that show nothing
   because nothing was ever actually captured.

**The fix: no module patching, no `--import`, manual spans only.** `NodeTracerProvider.register()`
registers a global tracer via a plain synchronous JS API call — no loader hook, works identically in ESM
or CommonJS. Every span this codebase creates is explicit, at exactly two points, both already existing
instrumentation seams from earlier phases rather than new code paths:

- **`mcp/server.ts`'s `withToolLogging`** — one span per MCP tool invocation (`find_slots`, `hold_slot`,
  `confirm_with_deposit`, ...), the same wrapper that already handles logging (dev-logs/017) and metrics
  (dev-logs/018). A refusal (`Refusal`) sets the refusal code as a span attribute but keeps span status
  `OK` — a refusal is a normal, structured domain outcome (docs/03-domain-model.md §5), not a trace-level
  error; a genuine thrown error sets `ERROR` status and records the exception.
- **`observability/metrics.ts`'s `instrumentRazorpayClient`** — one span per outbound Razorpay SDK call,
  the same Proxy that already records the call-duration histogram and counter (dev-logs/018).

Because `getTracer().startActiveSpan` picks up whatever span is already active in the current async
context, a Razorpay call made from inside a tool handler automatically becomes a **child span** of that
tool's own span — `confirm_with_deposit`'s trace genuinely shows `captureDeposit` calling
`payments.capture` underneath it, not two spans a reader has to correlate by hand. `getTracer()` is safe to
call unconditionally everywhere, `OTEL_ENABLED` unset or not: the OpenTelemetry API returns a no-op tracer
when no provider is registered, by design, so no call site outside `tracing.ts` itself needs its own
`if (env.OTEL_ENABLED)` guard.

## What this deliberately doesn't cover

No HTTP-request-level span wrapping the whole `/mcp` request, and no spans for merchant-api-only routes
(`decline_booking`, `mark_no_show`, `set_policy`, ...). The MCP tool span already is the meaningful unit of
work for everything MCP-callable; a JSON-RPC request could in principle carry multiple tool calls, so an
outer HTTP-level span would be a less meaningful wrapper, not a more complete one. The merchant-api-only
handlers aren't covered by the tool wrapper (they're never MCP tools) and weren't given their own — the
same scope-discipline earlier phases applied to metrics (dev-logs/018 skipped route-level counters for the
same four handlers, for the same reason: not named in what the spec was actually trying to solve).

## `OTEL_ENABLED` — off by default, and `mcp/stdio.ts` never turns it on at all

Already in the config schema since dev-logs/023 (added ahead of this phase, expecting it). Off means zero
SDK overhead for local dev and every test run — nothing here runs unless explicitly asked for.
`mcp/stdio.ts` never calls `startTracing()` at all, unlike every other entrypoint: `ConsoleSpanExporter`
(the fallback when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset) writes to stdout via `console.dir`, with no way
to redirect it — the exact same hazard `createLogger`'s stderr destination already exists to avoid there
(dev-logs/017), since stdout on that entrypoint **is** the live MCP JSON-RPC transport. `withToolLogging`
still opens a real span on that entrypoint too (`getTracer()` doesn't know or care which process it's in);
it's just never exported anywhere, which is the correct, safe behaviour there regardless.

## A real bug this phase found and fixed: unflushed spans lost on shutdown

`BatchSpanProcessor` buffers finished spans and only exports them periodically (a few seconds by default,
`ConsoleSpanExporter`/`OTLPTraceExporter` alike) — a span finished shortly before the process exits is
silently dropped unless something flushes the buffer first. None of the graceful-shutdown work from
dev-logs/022 knew tracing would exist yet, so nothing did. `shutdownTracing()` (`tracing.ts`) calls the
registered provider's `.shutdown()` — which force-flushes before actually shutting down — and every
entrypoint's `setupGracefulShutdown(...)` `onShutdown` list now includes it, in the same list `sql.end()`
already lives in. Verified as a real fix, not just plausible reasoning: called a tool, sent `SIGTERM`
within ~1-2 seconds (well inside the default ~5s batch window), and confirmed the span still appeared in
the exported output before the process's own "shutdown complete" log line — before the fix, that same
sequence would have dropped it silently.
