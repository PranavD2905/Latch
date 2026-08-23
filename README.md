# Latch

**Making Indian service businesses transactable by any AI agent.**

Razorpay AI Buildathon 2026 · Track 01: AI Growth & Agentic Commerce

---

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
| Receive nothing → pay nothing | **No-show → you pay for nothing** |
| Seller cannot un-sell it | **Doctor calls in sick, cancels your paid slot** |

UCP has three verticals — Shopping, Lodging, Food. There is no appointments primitive anywhere. Not in
UCP, not in ACP, not in any AI surface, and not at Razorpay.

Meanwhile Indian outpatient clinics run a **32% no-show rate**. For one eight-doctor clinic that is
**₹3 lakh/month evaporating**, and today it is entirely uncollectable — a no-show produces no
transaction at all.

## What Latch is

A **service-transaction layer** on a merchant's Razorpay account, exposed as an **MCP server** with
seven tools. Any third-party agent — Claude, ChatGPT, a user's own — can hold a slot, read the
cancellation ladder, pay a deposit, reschedule, and be charged for a no-show. No partnership, no
integration deal.

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
| `hold_slot` | **none** | Slot free | Concurrent holds; TTL | DB constraint |
| `confirm_with_deposit` | deposit capture | Live hold + policy acknowledged | Deposit amount; authorisation ceiling | Latch + **Razorpay** |
| `reschedule` | price delta only | Target free + ladder permits | Delta ≤ booking value | Latch |
| `cancel` | refund / retention | Tier from **server clock** | Ladder tier | Latch |
| `charge_no_show` | debit | Start elapsed **+** merchant marked non-attendance | The authorised amount | **Razorpay** |

## Three architectural claims

**1. The audit trail is the database, not a log beside it.**
Event-sourced. Booking state is a fold over an append-only event log. The system cannot move money
without appending an event, because appending the event *is* the money moving. The trail can't drift
from reality — it *is* reality.

**2. A money action cannot be written without explaining itself.**
Every money event carries four fields, enforced by the type system: `action` (which rupee moved),
`gate` (what permitted it), `bound` (the ceiling), `authority` (under which policy version). There is
no constructor that omits them.

**3. The dangerous bound lives outside our own trust boundary.**
The no-show charge is a **card authorisation** placed at booking for *exactly* the no-show fee and left
uncaptured. Razorpay's Capture API refuses any capture that is not equal to the amount authorised — so
there is no headroom, and a compromised Latch server cannot capture a rupee more than the customer
consented to in front of a stated policy.

> The bar asks for bounds that are *"impossible, not merely caught."* A server-side `if` is caught. A
> authorisation ceiling, a partial unique index, and a server-owned clock are impossible.

## The failure, handled

The doctor calls in sick on Wednesday. The merchant declines a confirmed, paid Thursday slot.

```
MERCHANT_DECLINED     cause=MERCHANT → cancellation ladder deliberately NOT applied
SLOT_RELEASED         returned to inventory
REFUND_ISSUED         ₹300 → original instrument
AUTHORIZATION_RELEASED  no-show authorisation left to lapse — never captured
ALTERNATIVES_OFFERED  3 matching slots pushed back to the originating agent

net customer cost ₹0 · orphaned authorisations 0 · stranded holds 0 · manual tickets 0
```

Chosen because it is a failure of the **domain**, not of the implementation — goods commerce has no
"seller rejects a paid order" flow at all. It is handling we had to build regardless, not a demo prop.

## Stack

TypeScript · MCP (Streamable HTTP) · Fastify · PostgreSQL · Drizzle · Zod · Vitest · Razorpay test mode

Full rationale, with rejected alternatives, in [`docs/02-tech-stack.md`](docs/02-tech-stack.md).

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/01-architecture.md`](docs/01-architecture.md) | System design, the three shaping ideas, trust model |
| [`docs/02-tech-stack.md`](docs/02-tech-stack.md) | Every choice, every rejected alternative, and why |
| [`docs/03-domain-model.md`](docs/03-domain-model.md) | Entities, state machine, event catalogue, ladder maths |
| [`docs/04-features-and-limitations.md`](docs/04-features-and-limitations.md) | Honest scope. What we won't build, and why |
| [`docs/05-cost-model.md`](docs/05-cost-model.md) | Production costs, unit economics, what this earns |
| [`docs/06-build-sequence.md`](docs/06-build-sequence.md) | 10 days, sliced vertically, with the video script |
| [`prompts/`](prompts/) | One self-contained session prompt per slice |
| [`dev-logs/`](dev-logs/) | Decision log, kept as we go |
| [`agentic-services-transactability-brief.md`](agentic-services-transactability-brief.md) | The original market research |

## Not to be confused with

**An AI receptionist.** Zenoti, Cleomitra, Caller Digital and others answer the merchant's phone —
inbound, aimed at humans, and saturated. Latch points the other way: it makes the merchant reachable
by everybody else's agents. Opposite arrows.

**Calendly plus a payment link.** Those are two systems glued by a webhook — today Razorpay↔Acuity is
literally wired through Zapier, where "Payment Captured" and "Appointment Scheduled" are unrelated
events. An agent cannot reason about two unrelated events as one object. Latch makes the calendar and
the money one transactable object.
