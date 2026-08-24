# Dev Log 012 — Slice 7: deploy and connect a remote agent

**Date:** 24 August 2026
**Phase:** Slice 7 (`prompts/slice-7.md`)
**Status:** Code done, verified locally against real Postgres. **The actual Railway deployment did not
happen this session** — deploying is not a fully local, reversible action (a Railway account, billed
infrastructure, something publicly reachable), and per the handoff from the prior session and this
project's own permission discipline, that step needs the user present. Everything up to "ready to run
`railway up`" is done; the live endpoint URL, the real remote-agent connection, and the deployed
viewer/failure-path verification are **carried forward**, not faked here.

---

## What was built

- **`src/adapters/load-env.ts`** — a real bug caught before it could bite in production: every
  entrypoint called `process.loadEnvFile?.('.env')`, and the optional-chaining only guards against the
  *function* not existing on an older Node — not against the *file* not existing. Verified directly
  (`node -e "process.loadEnvFile?.('.env')"` in a directory with no `.env`): it throws `ENOENT`, with or
  without an explicit path. Railway (and any real deployment) injects env vars straight into
  `process.env`, with no `.env` file on disk — every one of Slice 7's deployed entrypoints would have
  crashed on boot with the pre-existing code. `loadEnvFile()` wraps the call and swallows only `ENOENT`.
  Applied to `db/migrate.ts`, `db/seed.ts`, `mcp/stdio.ts`, `mcp/http.ts` (new), `merchant-api/http.ts`,
  `audit-trail/http.ts`, `worker/background.ts`, `worker/authorization-lapse.ts`. Left
  `demo/ceiling-refusal.ts` alone — it's a local-only demo script, never deployed.
- **`src/adapters/mcp/streamable-http-server.ts` + `src/adapters/mcp/http.ts`** — MCP over Streamable
  HTTP, docs/02-tech-stack.md §3. Stateless mode (`sessionIdGenerator` omitted), matching the MCP SDK's
  own reference pattern for a server whose tool handlers are pure functions of `deps` — Postgres is the
  only shared state, so there's no per-connection session worth paying a session-management protocol for.
  A fresh `McpServer` + transport per request, torn down when the response closes. `stdio.ts`'s
  `createServer(deps)` factory is reused completely unchanged — it already returned a fresh `McpServer`
  per call, so nothing about the tool-registration code needed to change at all.
  - **Deliberately unauthenticated.** The MCP endpoint has no bearer token, unlike `merchant-api` and the
    audit-trail viewer, which keep theirs. This is the one route meant to be genuinely open — Latch's
    thesis is that a third-party agent transacts with the merchant *without a partnership or an
    integration deal*; gating `/mcp` behind a token the agent would need to already have contradicts that
    directly. Real money never moves without Razorpay's own gates, and test mode is in effect regardless.
  - `mcp/http.ts` also runs both Slice 5 background jobs (hold-expiry, no-show-eligibility) and the
    Slice 4 authorisation-lapse worker as in-process `setInterval` loops, identical to how
    `worker/background.ts` and `worker/authorization-lapse.ts` already ran them standalone. Neither binds
    a port or holds per-connection state, so folding them into the one process that has to stay running
    for the HTTP server anyway satisfies slice-7.md's "the background worker running in the deployed
    process" without inventing a fourth Railway service.
  - Two `exactOptionalPropertyTypes` frictions surfaced against the SDK's own type declarations (not a
    logic bug on either side): `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`
    doesn't type-check (the option must be *omitted*, not set to `undefined`, to mean "stateless" — `{}`
    instead), and `StreamableHTTPServerTransport`'s `onclose`/`onerror`/`onmessage` accessor setters
    accept `| undefined` one degree looser than `Transport`'s own optional-property declarations, so
    `server.connect(transport)` needed an explicit `as Transport` at the call site. Both are commented in
    place.
- **`src/adapters/audit-trail/http.ts`** — now also serves the built `web/dist` viewer at `/`, same
  origin as `/events`, via `@fastify/static` (new dependency). Guarded with `existsSync` so local dev
  without a `web/dist` build (the normal path there is `npm run web:dev`'s Vite dev server, not this)
  doesn't break. This is what makes the deployed viewer need zero CORS handling — same reasoning
  `web/vite.config.ts`'s dev-time proxy comment already gives, just same-origin-for-real instead of
  proxied.
- **`src/adapters/db/client.ts`** — `postgres-js`'s default pool size (10/process) is fine for one local
  process against Postgres.app; three separate Railway services each holding a 10-connection pool against
  one managed instance is the "pool sized for localhost may exhaust them" risk slice-7.md names
  explicitly. Capped to 5/process by default, overridable via `DB_POOL_MAX`.
- **`src/adapters/db/seed.ts`** — policy bumped from `pol_v1`/version 1 to `pol_v4`/version 4. The
  ladder/deposit/no-show numbers were already identical to docs/03-domain-model.md §2's worked example;
  only the version number was off from what that doc (and slice-7.md's own "policy v4" seed requirement)
  actually shows. `pol_v1` had exactly one reference in the codebase (the seed file itself) — safe to
  change outright, confirmed by grep before touching it.
- **`docs/07-deployment.md`** (new) — the service topology this slice actually settled on and why, since
  "deploy to Railway" doesn't by itself say how many services or how they compose. See below.
- **`package.json`** — `mcp:http:dev`(`:razorpay`), `build:web`, `build:viewer`, `start:mcp`,
  `start:merchant-api`, `start:viewer`.

## The deployment shape: three Railway services, one Postgres

Documented in full in `docs/07-deployment.md`; summary here.

| Service | Entrypoint | Public | Also runs |
|---|---|---|---|
| `latch-mcp` | `src/adapters/mcp/http.ts` | Yes — the MCP endpoint | Both background workers |
| `latch-merchant-api` | `src/adapters/merchant-api/http.ts` | Yes — demo needs to curl it from outside | — |
| `latch-viewer` | `src/adapters/audit-trail/http.ts` | Yes — browser loads it directly | Static `web/dist` |

**Why three services and not one combined process.** Considered folding everything into a single
Fastify app on one port — fewer moving parts, one Railway service. Rejected: `merchant-api` and the
audit-trail server are each their own `Fastify()` instance with their own `onRequest` auth hook, already
exercised by `.inject()` in `merchant-api.integration.test.ts` and equivalents. Composing three
already-built instances onto one shared HTTP listener isn't something Fastify supports without either
refactoring all three into plugins (touches tested code for no functional gain) or adding an internal
reverse-proxy hop in front of the SSE stream specifically — the one thing slice-7.md's own buffering
warning says not to add complexity around. Three small services, each unchanged in shape from its
local-dev version, was the lower-risk call. Cost-wise this still lands in Tier 0
(`docs/05-cost-model.md` — three trivially small Node processes plus one small managed Postgres, well
under the $6–12/mo estimate; confirmed only on paper here, not against a real Railway invoice, since
nothing was actually provisioned).

## Verified locally, against real Postgres (not against Razorpay live, not deployed)

1. `npm test` — 119 tests, clean, no regressions from the `loadEnvFile`/seed/pool changes.
2. `TZ=UTC npx vitest run src/domain/ladder.test.ts src/domain/slots.test.ts` — forced the process's own
   system timezone to UTC and reran the ladder/slot tests: still clean. Backed by a grep, not just the
   test run: `src/domain/slots.ts`/`ladder.ts` compute everything via `.getTime()` UTC-instant arithmetic
   against an explicit `IST_OFFSET_MS` constant, with no call to a locale- or system-timezone-dependent
   `Date` method (`getHours`, `getDay`, `toLocaleString`) anywhere in the path. The Slice 0-1 design
   already made the server's own timezone irrelevant to the result — this was a real risk worth checking
   given slice-7.md's explicit warning, not a formality, and it checked out.
3. Ran `mcp/http.ts` for real (`MCP_HTTP_PORT=4010`, real seeded Postgres): `GET /healthz` → `200`;
   `GET /mcp` → `405` (stateless mode, no session to resume); a real MCP `initialize` handshake over
   `POST /mcp` returned a correct `protocolVersion`/`capabilities`/`serverInfo` response; `tools/call` for
   `find_slots` returned real IST-correct slot times (working hours 09:00–13:00/14:00–18:00 IST verified
   against the returned UTC instants by hand); `tools/call` for `get_policy` returned `policyVersion: 4`
   with the exact worked-example numbers, over the deployed transport shape, not just from the DB.
4. Ran `audit-trail/http.ts` for real after `npm run build:web`: `GET /` served the built viewer's
   `index.html` (`200 text/html`); `GET /events` without a token → `401`; with the token → a live SSE
   stream replaying real event history from the same seeded database.
5. `npx tsc --noEmit` clean across the whole change, including the two SDK-type frictions noted above.

**What is not verified, because it requires the deploy that didn't happen:** the public HTTPS endpoint
existing at all; a genuinely remote agent (not this same machine) connecting to it; the failure path
against the real Razorpay test dashboard from the deployed environment; the SSE viewer staying live
through Railway's actual proxy (buffering/idle-timeout behaviour is a property of Railway's edge, not
reproducible by running the same code locally); real infrastructure cost.

## Decisions made that the docs did not settle

- **No auth on `/mcp`.** Explained above and in `streamable-http-server.ts`'s own comment — the only
  design choice in this slice that's a genuine judgement call rather than a mechanical consequence of the
  existing architecture, so it's called out twice on purpose.
- **Background workers folded into the MCP process, not their own service.** Both are pure
  `setInterval` loops with no `app.listen()` — nothing about them needs isolation, and running them
  standalone would be a fourth service purely to host a timer.
- **Migrations run by hand (`railway run npm run db:migrate`), not prepended to every service's start
  command.** `drizzle-orm`'s Postgres migrator takes its own advisory lock, so three simultaneous cold
  starts all attempting it wouldn't race incorrectly — but running it once, deliberately, after a schema
  change is simpler to reason about than three processes racing a lock on every deploy. Full detail in
  `docs/07-deployment.md`.

## Carried forward — this is the actual state of Slice 7

**Not done, and this is the important part:** nothing is deployed. No Railway project exists, no
`DATABASE_URL` for a managed instance, no live endpoint URL, no remote agent has connected to anything.
The user chose, this session, to commit the code and pause here rather than proceed to provisioning —
correctly: creating billed, publicly-reachable infrastructure is not a call this session should make
unilaterally.

**Next session (or this one, resumed) needs to, in order:**
1. Create the Railway project + managed Postgres, with the user present for account/billing.
2. Set env vars per `docs/07-deployment.md`'s table on each of the three services.
3. Run `db:migrate` once, then `db:seed` once, against the Railway Postgres.
4. Deploy all three services; hit each one's `/healthz`-equivalent (the merchant-api and audit-trail
   services don't currently have a health route — worth adding one before relying on Railway's own health
   checks, if it gates deploys) to confirm they're actually up before wiring an agent to the MCP one.
5. Connect a real remote agent (a separate machine/session, not this sandbox) to the live `/mcp` URL and
   drive a full booking — this is "the actual deliverable" per slice-7.md, and nothing before this step
   substitutes for it.
6. Run the failure path (merchant decline) against the deployed services and cross-check the real
   Razorpay test dashboard.
7. Open the deployed viewer URL in a real browser and confirm the SSE stream stays live — specifically
   watching for the buffering/idle-timeout behaviour slice-7.md warns Railway's proxy can introduce, which
   only shows up against the real proxy, not locally.
8. Append this dev log (or write a 013) with the live endpoint URL and whatever behaved differently
   deployed than locally — there will very likely be something; there almost always is on a first deploy.
9. **Visual verification of the viewer is still separately owed from dev-log 011** — this session, again,
   had no way to open a browser and look at it. Both the local build (confirmed serving correctly here)
   and the eventual deployed version need an actual human eyeball before either goes in the pitch video.

## One thing outside this slice's scope, flagged anyway

`npm audit` reports a **high-severity SQL-injection advisory against `drizzle-orm`** (the version this
project already pins, unrelated to anything changed this session) among a handful of dev-tooling
advisories (`vite`/`vitest`/`esbuild`/`drizzle-kit`, all build-time only). Not investigated or acted on
here — out of Slice 7's scope, and the project's own money-critical queries lean on Drizzle's typed
query builder rather than raw string interpolation, per docs/02-tech-stack.md §6 — but worth someone
reading the actual advisory before Slice 8 or the final submission, given what this project moves.
