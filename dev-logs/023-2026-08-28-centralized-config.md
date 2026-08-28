# Dev Log 023 — a centralized, validated config module

**Date:** 28 August 2026
**Phase:** First of the four lower-priority items the user asked to pick up after the observability pass
(dev-logs/017-022) finished: centralized config, security headers, load testing, tracing — in that order.
**Status:** Built and tested. `npm test`: 226/226 passing (10 new in `config.test.ts`). `npx tsc --noEmit`
clean. Verified live: an invalid env var (`DB_POOL_MAX=notanumber`) fails fast with a specific, readable
error before the process does anything else; a valid config starts normally.

---

## What this replaces

Audited every `process.env` read across `src/` (23 distinct variables) — each one previously validated,
or failed to validate, differently: `Number(process.env['X'] ?? default)` silently produces `NaN` for a
bad value rather than erroring, `process.env['Y'] === 'true'` string-comparisons duplicated three times
with no shared definition, and `DATABASE_URL`'s own presence check was hand-written identically in four
different files (`build-deps.ts`, `migrate.ts`, `seed.ts`, `create-merchant.ts`).

`src/adapters/config.ts`'s `loadEnv()` is one Zod schema over all 23, parsed once and cached. A bad value
now fails at process startup with a specific, readable error (`DB_POOL_MAX: Invalid input: expected
number, received NaN`) instead of either a silent `NaN` propagating into `postgres-js`'s pool config or a
confusing failure three log lines later.

## A real ordering bug this surfaced along the way

`streamable-http-server.ts` read `MCP_RATE_LIMIT_MAX`/`MCP_RATE_LIMIT_WINDOW_MS` at its own module top
level. That module is statically imported by `mcp/http.ts` — and ES module imports resolve *before* the
importing module's own body runs, which means before that body's `loadEnvFile()` call ever executes. A
local `.env` file setting either of those two variables was silently never picked up; only a real
deployment env var (injected before the process starts at all) worked. Invisible in production, silently
broken for local dev. Moved both reads inside `createMcpHttpServer()`'s function body, which only ever
runs after the entrypoint's `loadEnvFile()` call — the same fix `loadEnv()` itself needed for the identical
reason (its own doc comment explains why it can't parse eagerly at its own module's top level either).

## What's deliberately still hardcoded, not lifted into env

The originating spec's own phrasing grouped "idempotency/circuit-breaker/shutdown timeouts" as one thing
to make configurable. Shutdown's timeout is genuine deployment tuning — `GRACEFUL_SHUTDOWN_TIMEOUT_MS` is
in the schema. The other two are safety margins, not tuning knobs, and left out on purpose:

- The idempotency cleanup worker's `pendingMaxAgeMs` (dev-logs/021) must stay well above the longest
  legitimate claim duration in this codebase, or GC can delete a row a *live* claimant still owns and
  reopen dev-logs/013's concurrent-claim race. An operator setting this via env, even unintentionally low,
  would silently reintroduce a real correctness bug with no error at parse time to catch it.
- The payment circuit breaker's `failureThreshold`/`cooldownMs` (dev-logs/020) are tuned against a specific
  "customer decline vs. genuine outage" distinction baked into `executePaymentCall`'s `isFailure`
  predicate, not an independently-adjustable dial.

Both stay as named constants with their reasoning attached at their own definition, exactly as before —
config centralization was about removing *duplicated, unvalidated* reads, not about maximizing what's
externally configurable.

## `DATABASE_URL` is optional in the schema — on purpose, one level down from where it matters

The obvious design would make `DATABASE_URL` required in `envSchema` directly. That breaks ~20 integration
test files, which each resolve their own `databaseUrl` via a local `process.env['DATABASE_URL'] ?? '...'`
fallback and pass the *result* straight to `createDbClient` as a parameter — never writing it back into
`process.env`. Once `createDbClient` itself started calling `loadEnv()` internally (for `DB_POOL_MAX` and
friends), a required-DATABASE_URL schema would have made every one of those tests throw the moment
`DATABASE_URL` wasn't literally set as a real env var, regardless of what was actually passed as the
connection string. `DATABASE_URL` stays optional in `envSchema`; `build-deps.ts`'s `requireDatabaseUrl()`
is the one place that still enforces it, with the same error every real entrypoint already threw. Caught
by actually running the test suite after the first pass, not anticipated — the first version of this
schema required it directly, and the fix here is what actually shipped.

## Everything else, briefly

`PAYMENT_PROVIDER`/`PAYMENT_RAIL` are now closed enums instead of open string-equality checks — a typo
like `PAYMENT_PROVIDER=Razorpay` (wrong case) now fails at startup instead of silently falling back to
`FakePaymentProvider`, which would have been a confusing way to discover the typo. A cross-field
`superRefine` enforces `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` together whenever `PAYMENT_PROVIDER=razorpay`
is set, replacing three separate hand-written versions of the same check. `.env.example` documents every
variable with its default, commented out — nothing needs to be set for local dev, every default already
matches what local dev already assumed.

Two env vars are pre-declared in the schema for work not yet built this session: `OTEL_ENABLED`/
`OTEL_EXPORTER_OTLP_ENDPOINT` (tracing, next) and `CORS_ALLOWED_ORIGINS` (security headers, after that) —
added now so the schema doesn't need a second pass once those land.
