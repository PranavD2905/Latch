# Latch — Tech Stack and Why

**Status:** Decided
**Date:** 23 August 2026

Every row below names what was chosen, what was rejected, and the reason. A stack choice with no
rejected alternative is not a decision, it is a default — so the rejections are the substance of this
document.

**The constraint that governs all of it:** a 1–2 week build, demoed live in 5 minutes, where the
correctness of *money movement* is the product. That biases every choice toward **fewer moving parts,
stronger compile-time and database-level guarantees, and things that are fast to explain out loud.**

---

## Summary table

| Layer | Chosen | Main alternative rejected |
|---|---|---|
| Language | TypeScript (Node 22 LTS), `strict` | Python, Java/Spring |
| Agent protocol | MCP via `@modelcontextprotocol/sdk` | Custom REST, UCP, A2A |
| MCP transport | Streamable HTTP (+ stdio for dev) | stdio only |
| HTTP server | Fastify | Express, Hono |
| Database | PostgreSQL | SQLite, MongoDB |
| DB access | Drizzle ORM | Prisma, raw `pg` |
| Validation | Zod | JSON Schema by hand, TypeBox |
| Money type | Branded integer paise | `number` rupees, decimal.js |
| Background jobs | DB-backed poller, in-process | BullMQ + Redis, cron |
| Live trail | Server-Sent Events | WebSocket, polling |
| Viewer UI | React + Vite + Tailwind | Next.js, server-rendered HTML |
| Tests | Vitest + fake adapters | Jest, integration-only |
| Payments | Razorpay Node SDK, test mode | Direct HTTP, Stripe |
| Hosting | Railway (app + Postgres) | Vercel, AWS, self-host |

---

## 1. Language — TypeScript on Node 22

**Chosen because:**

1. **MCP is TypeScript-first.** The Model Context Protocol reference SDK is written in TypeScript and
   is the most complete implementation. Every other language binding trails it. Since the entire
   agent-facing surface is MCP, building anywhere else means being a second-class citizen on the one
   interface that matters.
2. **One language covers the whole system.** MCP server, merchant API, background worker, audit
   viewer. In a 1–2 week build, a second language is a tax paid daily.
3. **The type system does real work here.** Idea 2 in the architecture — that a money event *cannot be
   constructed* without naming its gate, bound, and authority — is enforced by TypeScript's type
   checker. In a dynamically typed language that guarantee degrades from "won't compile" to "throws at
   runtime, hopefully in a test."

**Rejected — Python.** A genuinely close second. `FastMCP` is good and the Razorpay Python SDK exists.
Rejected because the type-level guarantee above is the spine of the design, and Python's type hints
are optional and unenforced at runtime. If the compiler cannot refuse the code, the guarantee is a
convention.

**Rejected — Java / Spring.** Razorpay's Java SDK is solid, but MCP tooling is thin, and the ceremony
cost is real when the deadline is measured in days.

**Note on `strict`.** `tsconfig` runs with `strict: true`, `noUncheckedIndexedAccess`, and
`exactOptionalPropertyTypes`. This is not fastidiousness — it is what makes "you cannot construct an
unexplained money event" actually true rather than mostly true.

---

## 2. Agent protocol — MCP

**Chosen because it is the idiomatic answer at Razorpay specifically.** The brief (§6.1) establishes
this: Razorpay has already normalised MCP as its agent interface — Razorpay MCP 1.0, Remote MCP at
`mcp.razorpay.com/mcp`, the Sarvam AI handoff, the Gnani.ai integration, Razorpay Dashboard on Claude.
Choosing MCP makes Latch *fit the host's world* rather than being novel for novelty's sake.

It is also the only option that lets an arbitrary agent — Claude, or a user's own — connect to a
merchant **without a partnership**. That is the whole thesis (brief §3, Layer 2: today's booking
integrations are gatekept by software adoption, not open).

**Rejected — a custom REST API.** Would work, but any agent would need bespoke integration code. The
gap being addressed is precisely that merchants are unreachable *without* bespoke integration.

**Rejected — building on UCP.** UCP has exactly three verticals: Shopping, Lodging, Food (brief §3,
Layer 1). There is no appointments vertical to build on. Forcing appointments into the Shopping schema
would mean fighting `line_items[].quantity`, shipping `destinations[]`, and `tracking_number` — the
exact mismatch the project exists to point out. We note UCP compatibility as future work instead.

---

## 3. MCP transport — Streamable HTTP, with stdio for local dev

**Chosen because the demo depends on it.** stdio means the agent spawns the server as a subprocess on
the same machine. That is a fine developer experience and a *terrible* demonstration — it looks like a
local script, not like a merchant being reachable over the internet.

Streamable HTTP means a **remote** agent connects to a **deployed** merchant endpoint. That is the
claim being made, so the transport should embody it.

We keep stdio wired up as well, purely for fast local iteration in Claude Code / Claude Desktop.

---

## 4. HTTP server — Fastify

**Chosen because:**

1. **Schema-first validation is built in.** Routes declare a schema; Fastify validates and serialises
   against it. When every input is a money action, having validation be a first-class route property
   rather than a middleware you remembered to add is the correct default.
2. **First-class TypeScript types.** Better inference than Express, which relies on community types.
3. **Native SSE support** for the live audit trail.
4. **Encapsulated plugins**, which map cleanly onto the adapter layering — MCP, merchant API, and SSE
   register as independent plugins that cannot reach into each other.

**Rejected — Express.** The safe default and perfectly capable. Rejected because its types are
community-maintained and it needs three or four middleware packages to reach where Fastify starts.

**Rejected — Hono.** Excellent and very fast, but its edge-runtime orientation is a poor fit: we need
long-lived Postgres connections and an in-process background worker, both of which want a normal
long-running Node process.

---

## 5. Database — PostgreSQL

**This is the least negotiable choice in the stack**, and for one reason:

> The double-booking guarantee is a **partial unique index**, and it is load-bearing.

```sql
CREATE UNIQUE INDEX one_live_booking_per_slot
  ON bookings (practitioner_id, starts_at)
  WHERE status IN ('held', 'confirmed');
```

That `WHERE` clause is what makes it work — a slot may have many cancelled or expired bookings in its
history, but only ever one live one. Postgres supports partial unique indexes. We also need real
transactions (the merchant-decline path appends five events atomically or none), `SELECT … FOR
UPDATE`, and `jsonb` for event payloads.

**Rejected — SQLite.** Tempting: zero setup, ideal for a demo. Rejected because SQLite serialises
writes and has no meaningful concurrency story. Concurrency is not incidental here — parallel agents
racing for one slot is a stated part of the thesis (brief Appendix A). Demonstrating that we survive it
requires a database that can actually experience the race.

**Rejected — MongoDB.** No transactional multi-document guarantees without configuration effort, and
partial unique indexes on a compound key with a status predicate are awkward. For a money system,
"transactions are available if you set it up right" is the wrong default.

---

## 6. DB access — Drizzle ORM

**Chosen because the generated SQL is legible.** Drizzle is a thin, typed layer over SQL — what you
write maps one-to-one onto what runs. Two consequences that matter here:

1. **We can drop to raw SQL where needed** (the partial index, `FOR UPDATE` locks) without leaving the
   type system or fighting the tool.
2. **We can show a judge the actual query.** Explaining a money-critical concurrency guarantee is far
   easier when the code reads like the SQL it becomes.

Drizzle also needs no separate engine binary or codegen step, which keeps deploys simple.

**Rejected — Prisma.** More popular and has a nicer schema DSL. Rejected on two counts: it abstracts
SQL away at exactly the moment we most want to see it, and partial unique indexes require escaping to
raw migration SQL anyway — so we would carry Prisma's weight and still hand-write the important part.

**Rejected — raw `pg`.** Full control, but hand-rolled row mapping across ~15 event types is a
meaningful chunk of the timeline spent on nothing interesting.

---

## 7. Validation — Zod

One schema definition serves three jobs: the MCP tool's advertised input schema, runtime validation at
the boundary, and the inferred TypeScript type. Defining these separately guarantees they eventually
disagree, and a disagreement between "what the agent was told it could send" and "what we actually
accept" is a security bug in a money system.

MCP's TypeScript SDK takes Zod schemas directly for tool definitions, so this is also the path of least
resistance.

---

## 8. Money — branded integer paise

```ts
type Paise = number & { readonly __brand: 'Paise' }
```

**Two rules, both absolute:**

1. **Integer paise, never rupees, never floats.** `0.1 + 0.2 !== 0.3` in IEEE 754. A cancellation
   ladder that computes 50% of ₹800 must produce exactly ₹400, every time, forever.
2. **Branded, so a raw `number` cannot be passed where money is expected.** Without the brand,
   `refund(bookingId, durationMinutes)` compiles fine. With it, it does not.

**Rejected — decimal.js / big.js.** Correct but unnecessary. Indian currency has no sub-paise unit, so
integers are exact by construction. Adding an arbitrary-precision library buys nothing and costs a
dependency plus conversion noise at every boundary.

---

## 9. Background jobs — DB-backed poller, in-process

Jobs exist for expiring holds and sweeping lapsed session-complete authorisations. Both are
low-frequency and idempotent. (A third, marking bookings no-show-eligible, existed through Slice 5 and
was removed along with the no-show feature — see the dev log for that removal.)

We run an interval inside the main Node process that queries for due work, claims rows with `FOR UPDATE
SKIP LOCKED`, and appends the resulting events.

**Rejected — BullMQ + Redis.** The standard answer, and wrong here. It introduces a second datastore,
a second failure mode, and a second thing to explain in a 5-minute video, to schedule roughly one job
per minute. `FOR UPDATE SKIP LOCKED` gives us safe claiming in a database we already run.

**Rejected — system cron / platform scheduler.** Coarse granularity and it lives outside the app,
which makes local testing and the demo harder.

**Re-reviewed, not just re-asserted (dev-logs/016).** An external architecture review independently
recommended "a resilient queue (Redis/RabbitMQ/Kafka) instead of single-node timers," which is exactly
the rejection above, named again by someone who hadn't read this doc. Re-examined honestly rather than
defended reflexively: the concrete thing that recommendation is actually asking for — background jobs
that stay correct if more than one process runs them — was true the day this was written (`FOR UPDATE
SKIP LOCKED` already made per-row claims safe under concurrent workers) and is *more* true now that it's
been tested under real multi-replica conditions: `src/adapters/db/advisory-lock.ts`'s
`pg_try_advisory_lock` guard (added for multi-tenant scaling, `docs/07-deployment.md`) means a whole
tick — not just one row's claim — is now also safe to run from more than one replica, at zero
additional infrastructure. A queue would add a second datastore, a second failure mode, and a second
thing to explain, to re-solve a problem this stack already solved twice over. Still two low-frequency,
idempotent jobs (plus the reconciliation worker, dev-logs/014, which is the same shape). The original
call stands, checked against the strongest form of the counter-argument, not merely repeated.

---

## 10. Live audit trail — Server-Sent Events

Data flows one way: server pushes events, browser renders them. SSE is exactly that, over plain HTTP,
with automatic reconnection built into the browser's `EventSource`.

**Rejected — WebSocket.** Bidirectional, and we need one direction. It brings connection lifecycle
management, heartbeats, and a protocol upgrade for no gain.

**Rejected — polling.** The trail must appear to update *as the agent transacts*, live on screen. A
2-second poll interval is visible and undercuts the effect.

---

## 11. Viewer UI — React + Vite + Tailwind

The audit trail viewer is a **product surface, not a debug page** — B5 says the trail must be *shown*,
"rendered legibly, not a log file." It is one of two things a judge looks at.

Vite for instant builds, Tailwind for speed without writing a design system, React because the trail is
a live-updating list with expandable event detail.

**Rejected — Next.js.** A full framework, SSR, routing, and a build pipeline for what is one page with
one data source.

---

## 12. Tests — Vitest, with fake adapters

**The testing strategy is the payoff for the hexagonal architecture, so it is worth stating explicitly:**

| Layer | How it is tested | Speed |
|---|---|---|
| Domain core | Pure unit tests. Frozen clock, in-memory state. Every ladder boundary, every gate, every refusal. | microseconds |
| App/command handlers — gate and refusal logic | Fake adapters (`src/adapters/db/fake-event-store.ts`, `fake-idempotency-store.ts`, `fake-catalog-repo.ts`, `fake-webhook-dead-letter-store.ts` — same pattern as `FakePaymentProvider`/`FakePaymentRail` below), no Postgres | milliseconds |
| Adapters, and anything that depends on real Postgres transaction/lock semantics | Integration tests against real Postgres and real Razorpay **test mode** | seconds |
| Concurrency | Parallel `hold_slot` calls against one slot, asserting exactly one wins — genuinely needs real row locks/the partial unique index, not reproducible against the fakes above | seconds |
| Full flows | End-to-end: hold → confirm → merchant decline → refund → authorisation released | seconds |

The ladder boundary tests are the ones that matter most. "Cancelling at exactly 48 hours" and
"cancelling at 47h59m" must be asserted deterministically, which requires a frozen clock, which
requires the `Clock` port. This is why the architecture is shaped the way it is.

**The middle row was a real gap, not a hypothetical one.** `EventStore`/`IdempotencyStore`/`CatalogRepo`
had no fakes for their first several slices — only `PaymentProvider`/`PaymentRail` did — so every command
handler's own gate/refusal logic (not the Postgres row-locking underneath it, the ordinary "does this
check refuse for the right reason" logic on top) could only be exercised through a live-Postgres
integration test, which is why 21 of this project's 32 test files were `.integration.test.ts`. The fakes
above close that specifically, deliberately narrow: they do not attempt to reproduce a real row lock,
`FOR UPDATE SKIP LOCKED`, the partial unique index, or a genuine two-connection race — `transaction()` on
the fake `EventStore` is a plain function call with no isolation, and `lockAgent` is a documented no-op.
Race 1/Race 2 and every background-worker concurrency test correctly stay `.integration.test.ts` against
the real store. See `src/app/confirm-with-deposit.fast.test.ts` for the pattern.

**Rejected — Jest.** Slower, and ESM support is still awkward. Vitest shares Vite's config and is
near-instant.

---

## 13. Payments — Razorpay Node SDK, test mode

Mandated by the competition, and correct anyway. Wrapped behind a `PaymentProvider` port so the domain
never imports the SDK, and so `FakePaymentProvider` can simulate declines, a payment link nobody has paid
yet (`'pending'`), and — importantly — **a rail-side capture rejection**, which is hard to trigger
reliably against a live sandbox but must be proven to work.

---

## 14. Hosting — Railway

App and Postgres in one place, deployed from a repo, with a public HTTPS URL — which the Streamable
HTTP transport requires so a remote agent can reach the merchant.

**Rejected — Vercel.** Serverless functions cannot host a long-lived SSE stream comfortably or run an
in-process background worker.

**Rejected — AWS.** Correct at scale, wrong for a two-week build. Time spent on IAM and VPCs is time
not spent on the product.

Costs are modelled in full in `05-cost-model.md`. The actual Slice 7 service topology — three small
Railway services (MCP, merchant API, audit-trail/viewer) sharing one managed Postgres, and why that beat
one combined process — is in `07-deployment.md`.

---

## 15. What we are deliberately not using

| Not used | Why |
|---|---|
| Redis | One datastore. See §9. |
| Kafka / event bus | Event sourcing ≠ needing a message broker. Postgres is our log. |
| Docker Compose for dev | One Postgres URL in `.env` is enough; containers slow iteration. |
| An auth framework | Per-merchant DB-issued API keys (migration 0011, `src/ports/merchant-auth.ts`) are enough — hashed-token-with-indexed-prefix is a well-understood pattern (same shape as Stripe's key format), not something that needs OAuth/session-framework machinery for one credential type with no user-facing login. Superseded §15 row: originally "one merchant, one static merchant token," when multi-tenancy itself was the non-goal — see docs/01-architecture.md §10. |
| A calendar library | Slots are computed from opening hours and a duration. `date-fns` + explicit IST handling covers it. |
| LangChain / agent frameworks | We are building the *thing agents talk to*, not an agent. Reaching for an agent framework here would signal a misunderstanding of the project. |

That last row is worth stating in the video. It is the fastest way to show that the direction of the
arrow (brief §3, Layer 3) is understood.
