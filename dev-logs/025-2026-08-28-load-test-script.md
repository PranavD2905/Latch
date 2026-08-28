# Dev Log 026 — a load-test script for hold_slot

**Date:** 28 August 2026
**Phase:** Third of the four lower-priority items (config module → security headers → **load testing** →
tracing).
**Status:** Built and verified live against a real running `latch-mcp` instance — 3,000 requests over 5s
at 5 connections, p50 latency 8ms, p99 24ms. Cross-checked the result against `GET /metrics`
(dev-logs/018): 2,702 real successes, 11 legitimate `SLOT_TAKEN` collisions, confirming the script's own
documented caveat (HTTP 200 doesn't distinguish a successful hold from a refused one) is accurate, not
just asserted.

---

## Where it lives, and why not `scripts/`

The spec's own suggested path was `scripts/load-test.ts`. This project's `tsconfig.json` only includes
`"src"` — a file outside it would silently escape both `tsc --noEmit` and `npm run build`, breaking from a
convention this codebase holds even for one-off admin tooling (`db:migrate`/`db:seed`/`db:create-merchant`
all live inside `src/adapters/db/`, not a separate top-level scripts folder). Adding `scripts` to
`tsconfig.json`'s `include` isn't a clean fix either — `rootDir: "src"` would then reject it (`tsc` errors
on a file outside `rootDir` being included). `src/adapters/load-test.ts` instead — same tier as
`build-deps.ts`/`config.ts`, same "single runnable script in its own file" shape `demo/ceiling-refusal.ts`
already established.

## Why `hold_slot`, specifically

Not an arbitrary pick: it's this system's zero-money, highest-frequency tool (docs/01-architecture.md §3 —
"all risk is pushed into the cheap, reversible phase"), so it's the one tool safe to hammer repeatedly
without moving real money or needing a human at Razorpay Checkout, and the one an actual agent fleet would
realistically call at the highest rate. `confirm_with_deposit` — the other candidate — cannot be load
tested unattended at all against real Razorpay (dev-logs/006/007: a human has to complete Checkout).

## Two design choices that make the numbers mean something

**A fresh `agentId` per request**, not one shared across the whole run. `hold_slot` enforces two real,
DB-verified per-agent bounds (`maxConcurrentHoldsPerAgent`, `holdRateLimitPerMinute` —
docs/01-architecture.md §12). Reusing one `agentId` across concurrent requests would mean most of them fail
on `HOLD_LIMIT_REACHED`/`RATE_LIMITED` almost immediately — a real bound working exactly as designed, but
noise for a throughput baseline, not signal. A fresh `ulid()`-based agent per request means those bounds
never engage at all, so the numbers measure the handler's own throughput, not how fast the rate limiter
rejects an agent that's already over quota.

**`startsAt` spread across a wide window** (a year out, 500,000-minute range, one-minute resolution) so
concurrent requests essentially never collide on the same slot — this measures `hold_slot`'s own
throughput, not its already-separately-tested `SLOT_TAKEN` collision path
(`concurrency-slot.integration.test.ts`). The live run's 11-out-of-2,713 collision rate confirms this
works as intended: present (a wide window doesn't guarantee zero), rare enough not to dominate the result.

## The one thing this script cannot tell you on its own, documented rather than hidden

MCP tool refusals (`SLOT_TAKEN`, `RATE_LIMITED`, ...) return **HTTP 200** with a JSON-RPC body marking the
outcome — autocannon only sees the transport-level status code, so "100% 2xx" does not mean "100%
successful holds." The script prints an explicit note pointing at `GET /metrics`'s
`latch_tool_invocations_total{tool="hold_slot"}` (dev-logs/018) for the real success/refused/error
breakdown, rather than silently reporting a number that looks like a success rate but isn't one.

## The one real operational gotcha, documented in the script's own header

`MCP_RATE_LIMIT_MAX` (dev-logs/017's transport-level DoS throttle, default 300 requests/60s per caller IP)
will dominate any run above that rate, since this script's own load necessarily comes from one IP — at
that point the numbers measure how fast the target *rejects* a flood, not how fast `hold_slot` completes.
The live verification run above set `MCP_RATE_LIMIT_MAX=10000` on the target server specifically to get a
genuine handler-throughput measurement rather than a rate-limiter-throughput one.
