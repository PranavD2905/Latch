# Dev Log 012 — Slice 7: deploy and connect a remote agent

**Date:** 24 August 2026
**Phase:** Slice 7 (`prompts/slice-7.md`)
**Status:** Deployed and verified for real. The code work below was written and verified locally first,
in an earlier part of this same session, with actual provisioning deliberately deferred pending the
user's explicit go-ahead (creating billed, public infrastructure is not a call to make unilaterally). The
user then asked to proceed with the deploy; what follows after "The actual deployment" section below is
what happened once that started, including two real bugs that only exposed themselves against the live
infrastructure and never showed up in any local test.

**Live endpoints** (Razorpay test mode, `main` branch, auto-deploys on push):
- MCP (Streamable HTTP, unauthenticated): `https://latch-mcp-production.up.railway.app/mcp`
- Merchant API (Bearer token): `https://latch-merchant-api-production.up.railway.app`
- Audit-trail viewer + SSE: `https://latch-viewer-production.up.railway.app`

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

**What that first pass could not verify, because it requires actually deploying:** the public HTTPS
endpoint existing at all; the failure path against the real Razorpay test dashboard from the deployed
environment; the SSE viewer staying live through Railway's actual proxy; real infrastructure cost. See
below for what happened once deployment actually started.

## The actual deployment

Railway CLI (`brew install railway`), `railway login`, `railway init --name latch`, managed Postgres via
`railway add --database postgres`. Services declared as code in `.railway/railway.ts` (Railway's
TypeScript infra-as-code, `railway` npm package as a devDependency) rather than clicked together in the
dashboard, so the topology decision above is reproducible and reviewable, not tribal knowledge — three
`service()` blocks (`latch-mcp`, `latch-merchant-api`, `latch-viewer`), each sourced from
`github("PranavD2905/Latch", { branch: "main" })`, `env` referencing `Postgres.env.DATABASE_URL` plus
literal `PAYMENT_PROVIDER: "razorpay"`, and secrets (`RAZORPAY_KEY_ID`/`_SECRET`,
`MERCHANT_API_TOKEN`, `AUDIT_TRAIL_TOKEN`/`VITE_AUDIT_TRAIL_TOKEN`) declared with `preserve()` so no
secret value is ever written to the committed file — real values set afterward via
`railway variable set --stdin`, reusing this session's own local-dev tokens (not especially sensitive:
Razorpay test mode, and both tokens only gate a narrow demo route / a read-only audit feed).
`railway config plan` previewed the exact diff before `railway config apply` — safe, reviewable, and
matches how every other infra change in this repo works: propose, read the diff, then commit.

**Two real bugs found only by deploying — this is exactly why slice-7.md says not to leave this to the
end:**

1. **`web/`'s dependencies were never installed during the build.** `build:web` ran `npm --prefix web run
   build`, but Nixpacks' Node build plan only runs `npm ci` at the repo root — `web/` is a separate
   `package.json` with its own lockfile, not an npm workspace, so its `node_modules` never existed in the
   build image. `latch-viewer`'s first build failed outright (`Cannot find module 'react'`, 20+ similar
   errors). Fixed by making `build:web` install first: `npm --prefix web ci && npm --prefix web run
   build`. Confirmed locally (`rm -rf web/node_modules web/dist && npm run build:viewer`) before
   redeploying.
2. **The SSE stream never opened against a genuinely empty `events` table.** `latch-viewer` built and
   passed its healthcheck, `/healthz` and `/` (the static viewer) both responded instantly — but
   `GET /events` hung forever: no headers, no body, nothing, confirmed with `curl -N` timing out, then
   confirmed it wasn't a proxy/networking issue at all by reproducing the identical hang from *inside* the
   container over `railway ssh` hitting `localhost:8080` directly, and again via Fastify's `.inject()`
   against the exact same running code. Root cause: `reply.raw.writeHead(200, {...})` doesn't itself put
   the response on the wire in Node — by default the header block is piggybacked onto the first
   `write()`/`end()` call. `sendBatch()` writes zero bytes when there's nothing to replay, and on a
   **freshly deployed, genuinely empty** database, that's true of the very first connection. Locally this
   never surfaced across two slices of testing because local Postgres always had leftover event history
   from earlier demo runs — the first `sendBatch()` always wrote *something*, which incidentally flushed
   the headers along with it. Fixed with one line, `reply.raw.flushHeaders()`, right after `writeHead()`.
   Verified against the real deployment: `curl -N` against `/events` on the empty table now returns real
   `HTTP/2 200` headers (`server: railway-hikari`, Railway's actual edge) in well under a second.

**Then the actual deliverable, proven against real infrastructure, not simulated:**

- `curl` from this local machine (a genuinely separate network hop from Railway, over the public
  internet — the same posture any third-party agent would have) against
  `https://latch-mcp-production.up.railway.app/mcp`: a real MCP `initialize` handshake, `find_slots`
  (IST-correct slot times, same code as the local check, now against Railway's own UTC system clock and
  Railway's own Postgres), `get_policy` (`policyVersion: 4`, exact seeded numbers), and `hold_slot` — a
  real `HOLD_CREATED` event, written to the real deployed Postgres.
- Watched that exact `hold_slot` call show up **live** in the deployed audit-trail SSE stream within one
  poll interval, via a background listener against `https://latch-viewer-production.up.railway.app/events`
  started *before* the booking call — not a replay, an actual live push, through Railway's real proxy, to
  a stream that had zero prior history seconds earlier.
- `/healthz` on all three services returns `200` over public HTTPS.
- `db:migrate` and `db:seed` both run cleanly against the real managed Postgres (via a **temporary** TCP
  proxy — `railway tcp-proxy create`, used only for the two one-off commands, then
  `railway tcp-proxy delete` immediately after; the private `postgres.railway.internal` hostname Railway
  gives every service by default is not resolvable from outside Railway's network, which is correct and
  is why the proxy was temporary rather than a standing feature).

**Not done, and worth being explicit about why:** `confirm_with_deposit` (the actual deposit capture) and
therefore the full failure path against the real Razorpay test dashboard were **not** driven against the
deployed environment this session. Both require a human completing real Razorpay Checkout in a browser —
the same constraint `demo/ceiling-refusal.ts`'s own comment and dev-logs/006/007 already document for
local testing, and nothing about deploying changes it. `hold_slot` (proven above) is real, unauthenticated
money-adjacent action against the deployed system; the deposit-capture step needs the user at a keyboard,
not a curl script.

## Cost, briefly

Provisioned: Railway Hobby-tier project, one managed Postgres (500MB volume, `ams` region), three tiny
Node services. Matches `docs/05-cost-model.md` Tier 0's shape exactly (three trivially small processes +
one small Postgres). Too early in the billing cycle to see a real invoice number — noting the shape
matches the estimate, not confirming the dollar figure yet.

## Decisions made that the docs did not settle

- **No auth on `/mcp`.** Explained above and in `streamable-http-server.ts`'s own comment — the only
  design choice in this slice that's a genuine judgement call rather than a mechanical consequence of the
  existing architecture, so it's called out twice on purpose.
- **Background workers folded into the MCP process, not their own service.** Both are pure
  `setInterval` loops with no `app.listen()` — nothing about them needs isolation, and running them
  standalone would be a fourth service purely to host a timer.
- **Migrations run by hand** (a temporary public TCP proxy on Postgres, `db:migrate`/`db:seed` run locally
  against it, proxy deleted immediately after), **not prepended to every service's start command.**
  `drizzle-orm`'s Postgres migrator takes its own advisory lock, so three simultaneous cold starts all
  attempting it wouldn't race incorrectly — but running it once, deliberately, is simpler to reason about,
  and there was no schema change in this slice to migrate in the first place (all eight migrations were
  already applied and verified in earlier slices; this just replayed them against a fresh database).
- **Health routes added to `merchant-api` and `audit-trail`**, unauthenticated on purpose (an
  `onRequest` auth hook exemption for `merchant-api`, since it gates every route globally). Named as a gap
  in the first pass of this log, closed before deploying rather than left for later — Railway's own
  healthcheck gates whether a deploy is considered successful.
- **`.railway/railway.ts` as infrastructure-as-code**, not a dashboard-clicked setup. Not strictly
  required by slice-7.md, but it makes the topology decision above reviewable and reproducible the same
  way every other architectural decision in this repo is — a file in the repo, not something only visible
  by clicking through Railway's UI.

## An unrelated incident during this session, worth recording

Mid-deployment, another Claude Code session (working on dev-log 007's Token HQ question, unrelated to
Slice 7) turned out to share this **exact same local git working directory** — not an isolated worktree —
and ran a commit that swept up this session's uncommitted in-progress changes (`.railway/railway.ts`, the
health-route edits, a `package.json` dependency) into its own unrelated commit, with a Claude co-author
trailer attached. Caught before it reached `origin` (`git log` showed a commit this session never made),
fixed by a `git reset --soft` + reconstructing a clean commit without the trailer — no work was lost, but
it confirms multiple sessions were operating on one shared checkout concurrently, which is a real
collision risk for whatever comes after this slice if the same setup is still in use.

## `confirm_with_deposit` against a real remote agent, and the `mcp-remote` timeout it surfaced

The user connected Claude Desktop to the deployed `/mcp` endpoint via `mcp-remote` (the standard bridge
for a stdio-only client talking to a remote Streamable HTTP server) and drove a real booking through it —
`hold_slot`, then `confirm_with_deposit`. This is the genuine deliverable: a separate client, on a
separate machine's process, transacting with the deployed merchant over the public internet. It worked —
but `confirm_with_deposit` appeared to hang in Claude Desktop, twice, and after the second attempt
`find_slots` stopped responding too, which read as the whole deployed server being down.

**It wasn't.** `/healthz` and a direct `find_slots` call both answered instantly the whole time. Checked
the real state: **the booking had actually confirmed** — `DEPOSIT_CAPTURED` → `AUTHORIZATION_HELD` →
`BOOKING_CONFIRMED`, ₹300 captured, ₹400 held uncaptured, all real, all on Razorpay's dashboard. Claude
Desktop just never got the response.

Root-caused rather than assumed. First hypothesis was a Railway edge/proxy timeout on a long-held POST
(the same *class* of issue as the SSE `flushHeaders` bug above). Tested directly: a raw `curl` against
`/mcp` calling `confirm_with_deposit` on an order deliberately left unpaid ran for the full 300 seconds,
successfully, complete with periodic SSE `: keepalive` comment lines the MCP SDK's own transport sends
automatically, and returned a correct `PaymentTimeoutError` at exactly 300000ms. **The deployed server and
Railway's network path handle a multi-minute request completely correctly.** That ruled out the server
side entirely.

The actual cause: `mcp-remote` bundles the MCP TypeScript SDK's `Client`/`Protocol` class, which has a
**hardcoded 60-second default request timeout** (`DEFAULT_REQUEST_TIMEOUT_MSEC = 6e4`, found directly in
`mcp-remote`'s bundled source) — and `mcp-remote` exposes no CLI flag or environment variable to override
it. Any request through that bridge taking longer than 60 seconds aborts client-side, regardless of
whether the server is still correctly working on it (which `confirm_with_deposit` routinely will, since it
waits on a human completing real Checkout). The aborted request appears to also leave the bridge's
connection in a bad state — `find_slots` failing right after is consistent with that, not with a server
outage.

**What actually fixes the demo experience, since the 60-second ceiling can't be configured away:**
1. **`get_booking`** (new MCP tool, below) — an agent whose write times out client-side now has something
   safe to check rather than guessing or blindly retrying.
2. **`confirm_with_deposit`'s tool description now says this explicitly** — instructs a calling agent to
   call `get_booking` first on a timeout, and only retry with the *same* `idempotencyKey` if the booking is
   still `HELD`. This is aimed squarely at the exact confusion this session hit.
3. **For the actual pitch video: complete Checkout quickly.** A human clicking through a real Checkout flow
   promptly (not alt-tabbing between a chat window and a hand-built test page, which is what made this
   session's own test run past 60s) will very likely land inside the 60-second window and never see this at
   all. Worth a dry run before Friday specifically to confirm.

## `get_booking` — the eighth tool

Added directly because of the incident above: read-only, no gate, no money — `deps.eventStore.loadSnapshot`
exposed as a tool, returning status/deposit/authorisation state for one booking. `docs/01-architecture.md`
§3 and `README.md` updated (seven tools → eight, everywhere they're counted); `mcp-e2e.integration.test.ts`
updated to assert the full eight-tool surface; a new `get-booking.integration.test.ts` covers the found and
not-found cases the same way every other command module's tests do. `npm test`: 121/121.

## Carried forward

1. **Visual verification of the viewer is still separately owed from dev-log 011** — this session again
   had no way to open a browser. The data layer is proven three times over now (local, live against the
   real deploy, and now via a real remote agent's actual booking); the rendering has still only been
   reasoned about from source, never looked at by a human.
2. Test `latch-mcp` on next redeploy: **the background workers' actual behaviour under a real crash-loop
   restart** (Railway restarting the container after a failure) hasn't been observed — the
   `flushHeaders`/unguarded-tick fixes were verified by making them succeed, not by deliberately breaking
   something to watch the restart policy work.
3. **A dry run of the actual pitch-video Checkout flow, timed**, per the mitigation above — confirm a
   prompt, real Checkout completion lands inside `mcp-remote`'s 60-second ceiling before relying on it live.

## One thing outside this slice's scope, flagged anyway

`npm audit` reports a **high-severity SQL-injection advisory against `drizzle-orm`** (the version this
project already pins, unrelated to anything changed this session) among a handful of dev-tooling
advisories (`vite`/`vitest`/`esbuild`/`drizzle-kit`, all build-time only). Not investigated or acted on
here — out of Slice 7's scope, and the project's own money-critical queries lean on Drizzle's typed
query builder rather than raw string interpolation, per docs/02-tech-stack.md §6 — but worth someone
reading the actual advisory before Slice 8 or the final submission, given what this project moves.
