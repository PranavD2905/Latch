# Latch

**Making Indian service businesses transactable by any AI agent.**

Razorpay AI Buildathon 2026 · Track 01: AI Growth & Agentic Commerce

---

## Try it right now — live, deployed, real Razorpay test mode

No setup required. These are running services, not screenshots.

| What | Link |
|---|---|
| **Live audit trail viewer** | **[latch-viewer-production.up.railway.app](https://latch-viewer-production.up.railway.app)** |
| MCP endpoint (connect any agent to it) | `https://latch-mcp-production.up.railway.app/mcp/mer_clinic` |
| Merchant API (decline / mark-complete / policy) | `https://latch-merchant-api-production.up.railway.app` |

Point any MCP-capable agent (Claude Desktop + [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), Claude Code, etc.) at the MCP URL above — no API key, no partnership, no integration call needed, which is the entire thesis. Ask it to *"find a dermatology consult slot with Dr. Rao and hold it."* Then open the viewer link and watch the event land, live, in the audit trail — no refresh needed.

## The problem

Tell your AI assistant *"book me a dermatologist for Thursday afternoon."*

It can **find** you one. It cannot **book** one, cannot pay a deposit, cannot read a cancellation
policy, and has no idea what to do when the doctor calls in sick on Wednesday.

Every agentic commerce protocol built in 2025–26 assumes you are buying a **thing** — a SKU, a
quantity, a shipping address, a tracking number. An appointment is not a thing. It is a slice of
someone's time, and time behaves differently:

| A shirt | A 3pm Tuesday slot |
|---|---|
| Unsold today → sold tomorrow | Unsold → **gone forever** |
| One price, paid once | Deposit now, balance at service |
| Return it, get a refund | *Move* it — same money, new time |
| Receive nothing → pay nothing | **No-show → the merchant still absorbs the cost** |
| Seller cannot un-sell it | **Doctor calls in sick, cancels your paid slot** |

UCP has three verticals — Shopping, Lodging, Food. There is no appointments primitive anywhere. Not in
UCP, not in ACP, not in any AI surface, and not at Razorpay.

Meanwhile Indian outpatient clinics run a **32% no-show rate**. For one eight-doctor clinic that is
**₹3 lakh/month evaporating** — and Indian merchants recover it the way the market actually does,
a deposit forfeited on no-show or late cancellation, not a Western-style post-hoc card debit. Latch's
job is to make that recovery mechanism agent-executable, not to invent a new one.

## What Latch is

A **service-transaction layer** on a merchant's Razorpay account, exposed as an **MCP server** with
seven tools. Any third-party agent — Claude, ChatGPT, a user's own — can hold a slot, read the
cancellation ladder, pay a deposit, and reschedule. A no-show forfeits that deposit per the ladder;
no partnership, no integration deal.

```
What exists today:   [Human] ──phone──▶ [Merchant's own AI] ──▶ [calendar]
                     (Zenoti et al. — saturated, inbound, at humans)

What Latch builds:   [Anyone's agent] ──MCP──▶ [Merchant] ──▶ [booking + money]
                     (nobody — outbound, at machines)
```

The novelty is not "an AI that books appointments." That is crowded. The novelty is **the
money-and-time semantics of a service transaction, in a form an arbitrary agent can execute against.**

## The seven tools

| Tool | Money action | Gate | Bound | Bound enforced by |
|---|---|---|---|---|
| `find_slots` | — | — | — | — |
| `get_policy` | — | — | — | — |
| `get_booking` | — | — | — | — |
| `hold_slot` | **none** | Slot free | Concurrent holds; TTL; per-agent hold rate | DB constraint |
| `confirm_with_deposit` | deposit capture | Live hold + policy acknowledged | Deposit amount; authorisation ceiling | Latch + **Razorpay** |
| `reschedule` | price delta only | Target free + ladder permits | Delta ≤ booking value | Latch |
| `cancel` | refund / retention | Tier from **server clock** | Ladder tier | Latch |

`confirm_with_deposit` returns immediately with a payable link rather than blocking the agent for
minutes on a human completing Checkout — the agent hands the link over, the human pays in their own
time, and `get_booking` reports which legs (deposit, session-complete mandate) are still outstanding.

## Architecture — the four ideas that shape everything

**1. The audit trail is the database, not a log beside it.**
Event-sourced. Booking state is a fold over an append-only event log. The system cannot move money
without appending an event, because appending the event *is* the money moving. The trail can't drift
from reality — it *is* reality.

**2. A money action cannot be written without explaining itself.**
Every money event carries four fields, enforced by the type system: `action` (which rupee moved),
`gate` (what permitted it), `bound` (the ceiling), `authority` (under which policy version). There is
no constructor that omits them.

**3. The dangerous bound lives outside our own trust boundary.**
The session-complete mandate is a **card authorisation** placed at booking for *exactly* the service's
remaining balance and left uncaptured until the merchant marks the session done. Razorpay's Capture API
refuses any capture that is not equal to the amount authorised — so there is no headroom, and a
compromised Latch server cannot capture a rupee more than the customer consented to in front of a
stated policy.

> The bar asks for bounds that are *"impossible, not merely caught."* A server-side `if` is caught. An
> authorisation ceiling, a partial unique index, and a server-owned clock are impossible.

**4. Every layer is hexagonal — domain, ports, adapters.**
`src/domain/` is pure: no HTTP, no database, no Razorpay SDK, no `Date.now()`. It only ever talks to
`src/ports/` interfaces (`Clock`, `EventStore`, `PaymentProvider`, `PaymentRail`). Concrete
implementations (`src/adapters/`) plug in from outside — which is what let the payment rail itself be
replaced mid-build (mandates → card manual-capture, `dev-logs/005`) without touching a single domain
file, and what let a second inbound surface (a plain REST `GET /slots`, reusing `find_slots`'s app-layer
handler unchanged) get built to prove that reuse claim rather than just assert it.

```
AI Agent ──MCP──▶ MCP Server ──command──▶ Domain Core (decides, touches nothing else)
                                                │
                                    only through an interface ("port")
                                                ▼
                              Postgres · Razorpay · System Clock
```

### Also real, not just documented

- **Multi-tenant**, added deliberately as a scalability proof once the core was solid (`migration 0011`) — real per-merchant, DB-issued credentials, tenant-scoped reads, `npm run db:create-merchant` onboards a new merchant with no redeploy. `docs/01-architecture.md` §10 keeps the original "not multi-tenant" call on record, struck through, with the reasoning for why it reversed cleanly — `merchantId` was threaded through the domain from Slice 0, so only the auth model ever needed to change.
- **A reconciliation worker and a signature-verified webhook** independently check the trail against what Razorpay's own API says actually happened, and record `RECONCILIATION_MISMATCH` on disagreement rather than trusting a synchronous response alone.
- **A circuit breaker** on outbound Razorpay calls, **webhook dead-lettering** after repeated identical failures, and **an advisory lock** that makes it safe to run more than one replica of the background workers without duplicating external API calls.
- **Structured logging, Prometheus metrics, OpenTelemetry tracing, graceful shutdown, and a centralized, validated env config** — the observability a real deployment needs, not a demo veneer.

Full rationale for every one of these, including what was evaluated and deliberately *not* built (a
Redis-backed job queue, chief among them — re-verified against the original decision rather than added
just because an external review suggested it), is in `docs/01-architecture.md` and the dev logs below.

## The failure, handled

The doctor calls in sick on Wednesday. The merchant declines a confirmed, paid Thursday slot.

```
MERCHANT_DECLINED     cause=MERCHANT → cancellation ladder deliberately NOT applied
SLOT_RELEASED         returned to inventory
REFUND_ISSUED         ₹300 → original instrument
SESSION_COMPLETE_AUTHORIZATION_RELEASED  mandate left to lapse — never captured
ALTERNATIVES_OFFERED  3 matching slots pushed back to the originating agent

net customer cost ₹0 · orphaned authorisations 0 · stranded holds 0 · manual tickets 0
```

Chosen because it is a failure of the **domain**, not of the implementation — goods commerce has no
"seller rejects a paid order" flow at all. It is handling we had to build regardless, not a demo prop.

## Running it yourself

**Prerequisites:** Node ≥22, a local Postgres (this project's own dev machine uses
[Postgres.app](https://postgresapp.com), not Docker — see `docs/07-deployment.md` for why), and (optional,
only needed for the real-payment paths) a Razorpay test-mode account.

```bash
npm ci
cp .env.example .env          # fill in DATABASE_URL at minimum; everything else has a sane default
npm run db:migrate
npm run db:seed               # creates the demo clinic, Dr. Rao, a service, a policy —
                               # and PRINTS a merchant-api token and an audit-trail token once.
                               # Copy them down; neither is stored anywhere in plaintext.
```

Run the pieces you need:

```bash
npm run mcp:dev                # MCP server over stdio — connect Claude Code/Desktop directly
npm run mcp:http:dev           # MCP over Streamable HTTP, the deployed transport shape
npm run merchant-api:dev       # decline / mark-complete / policy — the merchant-only surface
npm run audit-trail:dev        # the SSE feed the viewer reads
npm run web:dev                # the viewer itself, at localhost:5173
npm run worker:background:dev  # hold-expiry
npm run worker:dev             # authorisation-lapse
npm run worker:reconciliation:dev
```

Append `:razorpay` to any of the above (e.g. `npm run mcp:dev:razorpay`) to use the real
`RazorpayPaymentProvider`/`ManualCaptureRail` instead of the in-memory fakes — needs
`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` in `.env`.

### Running the tests

Integration tests run against a **second**, separate local Postgres on port 5433, isolated from your
dev database so test runs never pollute the live audit trail you're looking at:

```bash
initdb -D ~/.latch-test-pg-data -U latch --auth=trust
# edit ~/.latch-test-pg-data/postgresql.conf: port = 5433
pg_ctl -D ~/.latch-test-pg-data -l ~/.latch-test-pg-data/server.log start
createdb -h localhost -p 5433 -U latch latch_test
DATABASE_URL=postgres://latch:latch@localhost:5433/latch_test npm run db:migrate
DATABASE_URL=postgres://latch:latch@localhost:5433/latch_test npm run db:seed

npm test        # tsc --noEmit && vitest run — 262 tests, real Postgres, real Razorpay where the
                 # existing convention already does that (never mocked for those paths)
```

Full deployment topology, environment variables, and everything found only by actually deploying
(a real webhook registration, a real remote agent connecting, real bugs that never showed up locally)
are in [`docs/07-deployment.md`](docs/07-deployment.md).

## Stack

TypeScript · MCP (Streamable HTTP) · Fastify · PostgreSQL · Drizzle · Zod · Vitest · Razorpay test mode ·
Pino · Prometheus · OpenTelemetry

Full rationale, with rejected alternatives, in [`docs/02-tech-stack.md`](docs/02-tech-stack.md).

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/01-architecture.md`](docs/01-architecture.md) | System design, the shaping ideas, trust model |
| [`docs/02-tech-stack.md`](docs/02-tech-stack.md) | Every choice, every rejected alternative, and why |
| [`docs/03-domain-model.md`](docs/03-domain-model.md) | Entities, state machine, event catalogue, ladder maths |
| [`docs/04-features-and-limitations.md`](docs/04-features-and-limitations.md) | Honest scope. What we won't build, and why |
| [`docs/05-cost-model.md`](docs/05-cost-model.md) | Production costs, unit economics, what this earns |
| [`docs/06-build-sequence.md`](docs/06-build-sequence.md) | 10 days, sliced vertically, with the video script |
| [`docs/07-deployment.md`](docs/07-deployment.md) | The real Railway topology, env vars, and what only showed up once deployed |
| [`prompts/`](prompts/) | One self-contained session prompt per slice |
| [`dev-logs/`](dev-logs/) | The decision log, kept as we went — 30 entries, every judgment call and every bug this project actually hit, dated and in order. Start at `001` if you want the origin story; the most recent few are where the scalability and observability work lives. |
| [`agentic-services-transactability-brief.md`](agentic-services-transactability-brief.md) | The original market research |

## Not to be confused with

**An AI receptionist.** Zenoti, Cleomitra, Caller Digital and others answer the merchant's phone —
inbound, aimed at humans, and saturated. Latch points the other way: it makes the merchant reachable
by everybody else's agents. Opposite arrows.

**Calendly plus a payment link.** Those are two systems glued by a webhook — today Razorpay↔Acuity is
literally wired through Zapier, where "Payment Captured" and "Appointment Scheduled" are unrelated
events. An agent cannot reason about two unrelated events as one object. Latch makes the calendar and
the money one transactable object.
