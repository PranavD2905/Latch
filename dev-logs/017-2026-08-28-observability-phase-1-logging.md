# Dev Log 017 — observability, phase 1: structured logging + correlation IDs

**Date:** 28 August 2026
**Phase:** First slice of a larger observability/hardening request, handed over by cross-session
message with the user's own stated priority order: **Pino logging + correlation IDs** → Prometheus
metrics → error context → circuit breaker → idempotency cleanup → graceful shutdown. This entry covers
only the first item; the rest are still open, tracked below.
**Status:** Built and tested. `npm test`: 208/208 passing. `npx tsc --noEmit` clean. Verified live against
a running `latch-mcp` instance (curl), not just unit-level: `X-Trace-ID` extraction/generation/echo, and
per-tool-invocation log lines correlating to the same trace id as the request-level log.

---

## What was actually wrong

The originating spec (an external, generic "gaps and improvements" prompt) assumed a codebase with no
logging infrastructure at all, and proposed `src/infrastructure/logger.ts`, Zod validation inside
`src/app/*.ts` handlers, a second `/health` endpoint, and Redis-adjacent phrasing in a few places — none
of which match this repo as it actually stands (hexagonal `src/adapters/<concern>/` layout, transport-
boundary validation, `/healthz` already load-bearing for Railway, a standing no-Redis decision in
`docs/02-tech-stack.md`). Adapted rather than followed verbatim; the shape below is this codebase's own,
not the spec's.

## What was built

**`src/ports/logger.ts`** — a `Logger` port (`debug`/`info`/`warn`/`error`/`child`), the same hexagonal
discipline `Clock` already follows: `src/app/*.ts` depends on the port, never on Pino directly.

**`src/adapters/observability/logger.ts`** — `createLogger(service, destination?)` builds one Pino
instance per process. `pino-pretty` in dev, plain JSON on `NODE_ENV=production`. Pino's own logger
structurally satisfies the narrower `Logger` port with no wrapper class needed — verified by `tsc`, not
just assumed.

**One non-obvious correctness point:** `mcp/stdio.ts` is a process where stdout **is** the MCP JSON-RPC
transport. A log line on fd 1 there would corrupt the protocol stream, not just add noise — so
`createLogger` takes an optional `destination: 1 | 2`, and `stdio.ts` is the one caller that passes `2`
(stderr). Every other entrypoint (`mcp/http.ts`, `merchant-api/http.ts`, `audit-trail/http.ts`,
`rest/http.ts`, the three worker entrypoints) defaults to stdout.

**`src/adapters/observability/fastify-logging.ts`** — `loggingFastifyOptions(logger)` wires a pre-built
`Logger` into `Fastify({ loggerInstance, genReqId, requestIdHeader: 'x-trace-id', requestIdLogLabel:
'traceId' })` — Fastify's own `requestIdHeader` option does the "read an inbound `X-Trace-ID`, else
generate one" logic natively, so no hand-rolled extraction was needed. `echoTraceIdHeader(app)` adds the
`onSend` hook that returns it on the response. Used identically across all four Fastify servers (`mcp`,
`merchant-api`, `audit-trail`, `rest`).

**Hijacked replies are the one gap that helper doesn't cover.** `reply.hijack()` (the MCP routes, the SSE
feed) bypasses Fastify's `onSend` pipeline entirely — so those routes set `X-Trace-ID` by hand, directly
on `reply.raw`, before the first write. Missed on the first pass, caught by actually curling a `/mcp` call
and checking the response headers, not by reading the Fastify docs.

**`AppDeps.logger`** — required, not defaulted (`buildAppDeps(db, logger)` now takes it explicitly, same
"explicit over inferred" instinct `cancel`'s required `cause` field already follows in this codebase). The
MCP transport and merchant-api's `requestDeps()` both set it to `request.log`, not the process-level
logger — Fastify already builds that as `deps.logger.child({ traceId: request.id })` via
`requestIdLogLabel`, so every app-layer log line for a given request carries the same trace id a Fastify
access-log line for it would, with no separate threading.

**`src/adapters/mcp/server.ts`** — a `withToolLogging` wrapper replaces the repeated try/catch each of the
8 tool handlers had. One log line on start (`tool`, `args`), one on completion distinguishing
success/refused/error (the same three-way split `errorResult`/`refusalResult` already made, now logged
too), timed against `deps.clock` rather than `Date.now()` — this codebase's only source of "now"
(`docs/01-architecture.md` §5), which also makes a test driving a `FrozenClock` get a deterministic
duration.

**`src/adapters/observability/noop-logger.ts`** — the `Logger` counterpart to `FrozenClock`: a real,
minimal implementation for tests, not a mock. One real gotcha here: Fastify's `validateLogger` checks the
actual object at boot, at *runtime*, for `fatal`/`trace` methods — independent of `Logger`'s narrower
TypeScript shape, which only needed `debug`/`info`/`warn`/`error`/`child` for anything in `src/app/`. A
real Pino instance always has both; the noop test double didn't, and two integration tests that spin up a
real `createMerchantApiServer` failed at Fastify's own boot-time validation until `fatal`/`trace` no-ops
were added to it. Caught by running the suite, not by the type checker — `tsc --noEmit` was clean the
whole time, since the cast into `FastifyBaseLogger` silences the *type* check but not Fastify's own
runtime one.

**Console output deliberately left alone in three places:** `src/adapters/db/{migrate,seed,create-
merchant}.ts` (one-shot admin CLI tools whose output — including tokens meant to be copy-pasted — is
for a human running the script, not a service log) and `src/adapters/demo/ceiling-refusal.ts` (the
pitch-video narration). `buildAppDeps` still requires a `logger` argument in the latter two (a
`createLogger('latch-demo')`/no logger use at all otherwise), but nothing routes through it.

Every remaining `console.log`/`console.error` in a real service path (`mcp/http.ts`,
`streamable-http-server.ts`, `merchant-api/{http,server}.ts`, `audit-trail/{http,server}.ts`,
`rest/{http,server}.ts`, all three worker entrypoints, `app/webhook-dead-letter.ts`,
`app/reconciliation-worker.ts`) is now a structured `logger.info`/`logger.error` call.

## What's still open (next, per the stated priority order)

Prometheus metrics, structured error-context enrichment, a circuit-breaker check (likely already covered
— `src/app/circuit-breaker.ts` predates this session, wired into the reconciliation worker only so far),
idempotency-store TTL/GC, and graceful shutdown. None started this session.

## One known, accepted rough edge

Fastify logs a deprecation warning at boot (`requestIdLogLabel option is deprecated... removed in
fastify@6`). `package.json` pins `fastify: ^5.12.1`, where it still works exactly as used; the
replacement (`logController`, a class-based override) is a larger surface change than this slice
warranted. Left as a known, cosmetic warning rather than a silent trap for whoever bumps to fastify@6.
