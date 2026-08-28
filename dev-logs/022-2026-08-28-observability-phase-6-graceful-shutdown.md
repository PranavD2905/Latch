# Dev Log 022 — observability, phase 6: graceful shutdown

**Date:** 28 August 2026
**Phase:** Sixth and last item in the stated priority order (dev-logs/017): Pino logging → Prometheus
metrics → error context → circuit breaker → idempotency cleanup → **graceful shutdown**. This closes out
the observability/hardening pass handed over by cross-session message.
**Status:** Built and tested. `npm test`: 216/216 passing (process-signal behaviour isn't meaningfully
unit-testable, so this was verified live instead — see below). `npx tsc --noEmit` clean.

---

## Verified live, not just read

Spun up `latch-mcp` as a real subprocess against the local test database and sent it a real `SIGTERM`
(after finding the actual Node process — `npx tsx` runs the script in a child process, so the PID `$!`
captures is a wrapper, not the one that logs or listens; found the real one via `lsof -ti :4099` instead
of trusting the wrapper's PID). The full sequence logged correctly and the process exited in ~280ms:
`shutdown signal received, draining in-flight work` → (app closed, both `setInterval`s cleared, `sql.end()`
awaited) → `shutdown complete`, clean exit — comfortably inside the 10s backstop.

## What was missing

Nothing in this codebase listened for `SIGTERM` before this. Every deploy/restart on Railway (or a local
`docker stop`/Ctrl-C) killed all five long-running entrypoints (`mcp/http.ts`, `merchant-api/http.ts`,
`audit-trail/http.ts`, `rest/http.ts`, and the three standalone `worker/*.ts` processes) immediately:
in-flight HTTP responses dropped mid-request, a background tick mid-Razorpay-call got cut off instead of
finishing, and the raw `postgres` connection pool was never closed, just abandoned. Not catastrophic — every
money-moving command is already idempotency-key-safe to retry (docs/01-architecture.md §6), which is
exactly the path this forced more often than it needed to — but a routine deploy shouldn't look identical
to a crash in the logs, and a dropped connection is needless churn against Postgres's own connection limit.

## `setupGracefulShutdown(logger, { app?, onShutdown?, timeoutMs? })`

One function (`src/adapters/observability/graceful-shutdown.ts`), used by all eight entrypoints, shaped
around the two things that actually differ between them rather than duplicating the signal-handling
boilerplate eight times:

- **`app`** (the four Fastify servers only) — `FastifyInstance.close()` stops accepting new connections
  and waits for in-flight ones to finish, including a hijacked one (the MCP transport, the audit-trail SSE
  feed): Fastify's own reply machinery stops tracking a hijacked request once `reply.hijack()` runs, but
  the underlying HTTP connection is still open and Node's server-close semantics still wait for it.
- **`onShutdown`** (every entrypoint) — an ordered list run after `app` closes: `clearInterval` on each
  background tick (so a fresh iteration can't start mid-shutdown), then `sql.end()` on the Postgres pool.
- **`timeoutMs`** (default 10s) — the backstop. `app.close()`'s wait is unbounded on its own; without this,
  one open connection that never voluntarily closes would hang shutdown forever. This matters most for
  `audit-trail/http.ts`: its `GET /events` SSE feed is a genuinely long-lived connection a browser tab
  might leave open indefinitely, called out explicitly at that entrypoint's own call site rather than left
  implicit.

A second `SIGTERM`/`SIGINT` mid-shutdown is a no-op, not a second race — Railway (or `docker stop`) can
send more than one if a deploy is slow, and running the sequence twice concurrently would double-close
things that don't tolerate it (`sql.end()` twice, an already-closing Fastify instance).

## `mcp/stdio.ts` deliberately skipped

It's a short-lived subprocess Claude Code/Desktop spawns and owns the lifecycle of, with no background
workers and no HTTP connections to drain — the two things this whole mechanism exists to protect. Node
exits naturally once its stdio pipes close; adding signal handling there would be solving a problem that
entrypoint doesn't have.

## The observability pass, in full

Six sessions' worth of work across seven dev-log entries (017-022, this one included), all against the
same stated priority order: structured logging with request correlation (017), Prometheus metrics (018),
structured error context plus a Fastify-level safety net (019), a circuit breaker for money-moving Razorpay
calls that the existing one didn't cover (020), idempotency store garbage collection that also fixed a
real crashed-claimant leak (021), and this. Every phase adapted the originating spec to what this codebase
actually already had, rather than following it verbatim — named explicitly, phase by phase, rather than
silently diverging.
