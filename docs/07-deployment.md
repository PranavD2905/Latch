# Latch — Deployment (Slice 7)

**Status:** Decided, not yet provisioned — see dev-logs/012.
**Date:** 24 August 2026

This documents the actual shape of "deploy to Railway" from `prompts/slice-7.md`, since the prompt names
the destination but not the service topology, and that decision isn't obvious from the code alone.

## Topology — three Railway services, one Postgres

Fastify's plugin encapsulation (docs/02-tech-stack.md §4) already keeps MCP, the merchant API, and the
SSE audit trail as three independent `FastifyInstance`s with their own auth. Slice 7 keeps that boundary
at the deployment layer too, rather than merging them into one process:

| Railway service | Runs | Public? | Why |
|---|---|---|---|
| `latch-mcp` | `npm run start:mcp` (`src/adapters/mcp/http.ts`) | Yes | The public HTTPS MCP endpoint a remote agent connects to. Also runs both Slice 5 background jobs (hold-expiry, no-show-eligibility), the Slice 4 authorisation-lapse worker, and (dev-logs/014) the reconciliation worker as in-process `setInterval` loops — none of the four bind a port or hold per-connection state, so folding them in here satisfies "the background worker running in the deployed process" without a fifth service. |
| `latch-merchant-api` | `npm run start:merchant-api` (`src/adapters/merchant-api/http.ts`) | Yes | The merchant-only decline/mark-no-show routes, exercised during the demo from outside the deployed environment (curl / a script on the presenter's machine, not the agent). Also hosts `GET /slots` (dev-logs/014, item 4 — public, read-only, same posture as MCP's `find_slots`) and `POST /webhooks/razorpay` (dev-logs/014, item 2 — HMAC-signature-gated, not the merchant Bearer token), both mounted on this same already-public Fastify instance rather than provisioning a fourth service. |
| `latch-viewer` | `npm run start:viewer` (`src/adapters/audit-trail/http.ts`) | Yes | The SSE feed **and** the built `web/dist` viewer, served from the same origin — no CORS handling needed, same reasoning `web/vite.config.ts`'s dev-time proxy already used. |
| Postgres | Railway managed Postgres | No (internal) | Shared `DATABASE_URL` across all three services. |

**Why not one combined process.** Was considered, since it would mean one Railway service instead of
three. Rejected: it would blur exactly the boundary docs/02-tech-stack.md §4 point 4 calls out
("independent plugins that cannot reach into each other") into "one process that happens to expose three
things," and — more concretely — `merchant-api`'s and the viewer's auth hooks are `onRequest` hooks
scoped to their own `Fastify()` instance; composing three already-built instances onto one shared HTTP
listener isn't something Fastify supports directly without either refactoring all three into plugins
(touches tested code, `merchant-api.integration.test.ts` and equivalents call `.inject()` directly against
the instance `createMerchantApiServer` returns) or adding an internal reverse-proxy hop in front of the
SSE stream specifically — which is the one thing slice-7.md's own buffering warning says not to add
complexity around. Three small services, each unchanged from its local-dev shape, is simpler and safer.

**Why not a fourth service for the background workers.** Both `src/adapters/worker/background.ts` and
`src/adapters/worker/authorization-lapse.ts` are pure `setInterval` loops with no `app.listen()` call —
nothing about them needs their own service. Running them inside `latch-mcp` (the entrypoint that already
has to start a long-running process for the HTTP server) is free.

## Environment variables (per service, set in Railway, never committed)

All three services need:
- `DATABASE_URL` — Railway's Postgres reference variable (`${{Postgres.DATABASE_URL}}` in Railway's UI).
- `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` — real Razorpay test-mode keys.
  Deliberately still opt-in via `PAYMENT_PROVIDER` rather than automatic (dev-logs/006) — set it
  explicitly on every deployed service, not just where keys happen to be present.
- `DB_POOL_MAX` — optional, defaults to 5 per process (`src/adapters/db/client.ts`). Three services x 5 =
  15 connections against Postgres at rest, before `db:migrate`/`db:seed` one-off runs stack on top.
  Lower it if the managed instance's connection limit is tight.

**Migration 0011 superseded this section's original `MERCHANT_API_TOKEN`/`AUDIT_TRAIL_TOKEN` env vars** —
neither exists anymore. Both surfaces now authenticate against real, per-merchant, DB-issued credentials
(`merchant_credentials` table, `src/ports/merchant-auth.ts`) instead of one static string shared by every
merchant a deployment would ever serve. Run `railway run --service latch-merchant-api npm run db:seed`
(mints one demo merchant's credentials) or `npm run db:create-merchant -- "Merchant name"` (onboards a
new one, any time, no redeploy) against any of the three deployed services — they share one Postgres, so
it doesn't matter which service's `railway run` you use — and copy down the tokens it prints; neither is
ever stored in plaintext, so that's the only place either is visible again.

`latch-merchant-api` needs `RAZORPAY_WEBHOOK_SECRET` for `POST /webhooks/razorpay` to be enabled rather
than return `503` (dev-logs/014) — the secret registered against this exact service's public URL via
Razorpay's Webhooks API (`client.webhooks.create`, real test-mode keys, no manual Dashboard step needed —
see dev-logs/014 for the registration itself and the one caveat: `events` must be passed as an
`{eventName: boolean}` map, not an array, despite the SDK's own TypeScript signature accepting `any`).
`latch-viewer` additionally needs, at build time only, `VITE_AUDIT_TRAIL_TOKEN` set to one merchant's
`audit_trail`-scope token (Vite bakes it into the static bundle — see `web/src/App.tsx`; one viewer build
shows exactly one merchant's trail, since the server resolves the merchant from the token itself) **and**,
also at build time, `VITE_MERCHANT_API_URL` set to `latch-merchant-api`'s own public URL (dev-logs/015:
the policy editor's `GET`/`POST /policy` calls are genuinely cross-origin in production, unlike
`/events` — `latch-merchant-api` now runs `@fastify/cors` to allow it). Unlike `VITE_AUDIT_TRAIL_TOKEN`,
this is a public base URL, not a secret — the merchant's actual `merchant_api` bearer token is entered
into the editor at runtime and kept only in that browser tab's `sessionStorage`, never baked into the
bundle. `latch-mcp` needs neither: the MCP endpoint is deliberately unauthenticated for *agent* callers
(`src/adapters/mcp/streamable-http-server.ts`'s own comment explains why — gating it behind a token an
agent would have to obtain first would contradict the "no partnership required" thesis) — a remote agent
instead addresses `/mcp/:merchantId`, a public, discoverable path segment naming which merchant it means
to transact with, not a secret credential.

None of the three set `PORT` — Railway injects it per service, and every entrypoint now prefers
`process.env.PORT` over its local-dev default port.

## Build and start commands

Every service shares the same repo and the same `npm run build` (plain `tsc` to `dist/`), except
`latch-viewer`, which also needs the React app built: use `npm run build:viewer` (`tsc && npm --prefix web
run build`) as its Build Command, `npm run start:viewer` as its Start Command. `latch-mcp` and
`latch-merchant-api` use the default `npm run build` / their respective `npm run start:*`.

## Migrations

`npm run db:migrate` runs `drizzle-orm`'s Postgres migrator, which takes its own advisory lock — safe to
run from more than one service's start sequence without a race. Practically, run it once by hand
(`railway run npm run db:migrate` against whichever service, or as a one-off Railway command) after every
schema change, rather than prepending it to all three start commands — simpler to reason about, and
avoids three simultaneous cold starts all racing to migrate on a fresh deploy.

**The migration-timestamp gotcha named in dev-logs/010 and hit for real in dev-logs/011 still applies.**
If a new migration is ever generated via `drizzle-kit generate` as part of this deploy path, check its
`when` in `meta/_journal.json` against the last hand-bumped entry before trusting `db:migrate` applied it
— `drizzle-kit`'s `Date.now()` timestamp can sort behind an earlier hand-bumped one, and the migrator
skips it silently. Not a live risk right now: no schema change shipped in this slice, so `db:migrate` on
Railway is applying the same eight already-verified migrations that ran locally.

## Connection pooling, IST/UTC, cold starts — what Slice 7 found

- **Pooling.** Addressed above — `DB_POOL_MAX` (default 5/process) replaces `postgres-js`'s unmodified
  default of 10/process.
- **IST/UTC.** `src/domain/slots.ts` and `src/domain/ladder.ts` were already written against `.getTime()`
  UTC-instant arithmetic with an explicit `IST_OFFSET_MS` constant — no call to a locale- or
  system-timezone-dependent `Date` method (`getHours`, `getDay`, `toLocaleString`) anywhere in the ladder
  or slot-computation path. Verified by grep, and by running `npm test` with `TZ=UTC` forced (dev-logs/012)
  — this was a real risk worth checking, not a formality, but the Slice 0-1 design already made the server
  clock's own timezone irrelevant to the result.
- **Cold starts.** Both background-worker tick loops (`src/adapters/mcp/http.ts`) run their first tick
  synchronously (`await backgroundTick()`) before `setInterval` is armed, same as the local-dev
  entrypoints already did — a cold start doesn't lose the first minute of work, it just delays it by
  however long the container took to boot.

## Scalability hardening — what a scalability-focused review found

Four gaps, each fixed at the code level rather than only documented:

- **The audit-trail SSE feed used to poll once per connected browser tab.** N viewers of the same
  merchant meant N independent `listAllEvents` queries every 500ms — cost scaled with viewer count, not
  event volume. `src/adapters/audit-trail/server.ts` now runs one shared poll per *merchant* (created on
  the first connection, torn down on the last disconnection), fanning results out in-process to every
  listener for that merchant — a new connection's one-time catch-up query is unaffected, only the
  recurring poll is shared.
- **The reconciliation worker made its real Razorpay calls one candidate at a time, fully sequential.**
  Tick duration scaled linearly with confirmed-booking volume. `src/app/concurrency.ts`'s
  `mapWithConcurrency` bounds it to 8 candidates in flight at once (`reconciliation-worker.ts`) — enough
  to keep a tick's wall-clock cost roughly flat as volume grows, without turning a routine reconciliation
  pass into a burst the payment provider's own rate limiter would flag.
- **Nothing stopped two replicas of the same background-worker process from doing the same tick's work
  twice** — safe (`FOR UPDATE SKIP LOCKED` makes the row-level claims correct either way) but wasteful,
  and for the reconciliation leg specifically, wasteful means duplicated external API calls, not just
  duplicated CPU. `src/adapters/db/advisory-lock.ts`'s `withGlobalLock` (`pg_try_advisory_lock`, one
  `sql.reserve()`d connection) now guards every tick — this is what actually makes it safe to set
  `replicas > 1` on `latch-mcp` in `.railway/railway.ts`, which nothing did before.
- **`DB_POOL_MAX` was already this deployment's whole connection budget, and nothing enforced it once
  replicas entered the picture** — `max` × replica count has no ceiling from inside `createDbClient`.
  `src/adapters/db/client.ts` now also sets `idle_timeout`/`max_lifetime` (return idle connections
  instead of holding `max` open regardless of load) and a `DB_TRANSACTION_POOLER` flag (`prepare: false`)
  for the day a PgBouncer/Railway-pooling layer sits in front of Postgres — the real fix for horizontal
  scaling past what raw per-process pools can budget for, which this flag makes the codebase ready for
  without itself standing up that infrastructure.

Migration 0011 (real multi-tenant auth, above) is the fifth item from that same review — folded into its
own section rather than listed here because it changed the auth model, not just a performance
characteristic.
