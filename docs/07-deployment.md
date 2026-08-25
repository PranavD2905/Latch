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

`latch-merchant-api` additionally needs `MERCHANT_API_TOKEN` and, for `POST /webhooks/razorpay` to be
enabled rather than return `503` (dev-logs/014), `RAZORPAY_WEBHOOK_SECRET` — the secret registered
against this exact service's public URL via Razorpay's Webhooks API (`client.webhooks.create`, real
test-mode keys, no manual Dashboard step needed — see dev-logs/014 for the registration itself and the
one caveat: `events` must be passed as an `{eventName: boolean}` map, not an array, despite the SDK's
own TypeScript signature accepting `any`). `latch-viewer` additionally needs
`AUDIT_TRAIL_TOKEN` **and**, at build time only, a matching `VITE_AUDIT_TRAIL_TOKEN` (Vite bakes it into
the static bundle — see `web/src/App.tsx`) **and**, also at build time, `VITE_MERCHANT_API_URL` set to
`latch-merchant-api`'s own public URL (dev-logs/015: the policy editor's `GET`/`POST /policy` calls are
genuinely cross-origin in production, unlike `/events` — `latch-merchant-api` now runs `@fastify/cors` to
allow it). Unlike `VITE_AUDIT_TRAIL_TOKEN`, this is a public base URL, not a secret — the merchant's actual
bearer token is entered into the editor at runtime and kept only in that browser tab's `sessionStorage`,
never baked into the bundle. `latch-mcp` needs neither: the MCP endpoint is deliberately
unauthenticated (`src/adapters/mcp/streamable-http-server.ts`'s own comment explains why — gating it
behind a token would contradict the "no partnership required" thesis).

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
