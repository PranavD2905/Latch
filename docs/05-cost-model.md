# Latch — Cost Model / What It Takes To Run This For Real

**Status:** Living document — update as real numbers land
**Date:** 23 August 2026
**FX assumption:** $1 ≈ ₹88 (approximate, Aug 2026 — revalidate before quoting)

This file answers three separate questions that are easy to conflate:

1. **What does it cost to run Latch?** (infrastructure — small, fixed)
2. **What does each money action cost?** (payment fees — variable, and where the surprises are)
3. **What does Latch earn, for the merchant and for Razorpay?** (the case for building it)

---

## Part 1 — The headline finding: Latch has almost no COGS

Most products described as "AI products" have a cost of goods sold that scales with usage, because
every interaction burns model inference. Latch does not, and the reason is structural:

> **Latch is the thing agents talk *to*. It does not run a model.**

The inference — understanding the user, deciding to book, phrasing the confirmation — happens inside
*the customer's* agent (ChatGPT, Claude, whatever they use). That cost sits with the agent's owner,
not with Latch and not with the merchant.

Latch's marginal cost per booking is a handful of Postgres writes and two Razorpay API calls.

This is worth saying explicitly in the pitch, because it inverts the usual objection. The usual
question to an AI product is *"what happens to your margins at scale?"* Here the answer is that the
margin structure is that of a payments integration, not an AI product.

**One deliberate design consequence:** the `ALTERNATIVES_OFFERED` step in the failure path — computing
three replacement slots — is a **calendar query, not an LLM call.** It would have been easy to reach
for a model there. Doing so would have introduced non-determinism, latency, and per-event cost into
the recovery path of a money failure. It is a database query with a filter, and it must stay one.

---

## Part 2 — Payment costs (Razorpay, live mode)

### The rate card

| Item | Rate | Source |
|---|---|---|
| Platform fee — cards, UPI, netbanking, wallets | **2.00%** | razorpay.com/pricing |
| Platform fee — RuPay credit card via UPI | 2.15% | razorpay.com/pricing |
| GST on the fee (not on transaction value) | **18%** | razorpay.com/pricing |
| **Effective all-in rate** | **2.36%** | 2% × 1.18 |
| Setup fee | ₹0 | razorpay.com/pricing |
| Annual maintenance (AMC) | ₹0 | razorpay.com/pricing |
| Normal refund processing fee | ₹0 | razorpay.com/pricing |
| Uncaptured authorisation (never captured) | **₹0** — no capture, no fee | razorpay.com/docs (capture settings) |

Note the UPI line specifically. UPI has **zero MDR** by RBI policy — the bank charges the merchant
nothing. Razorpay's 2% is a *platform/technology fee* for the infrastructure, not an interchange
charge. This distinction matters when explaining the number to a merchant, who will have read that
"UPI is free."

### ⚠️ The cost that catches people out: refunds do not return the fee

**Verified from Razorpay's own documentation:** on a refund, the customer gets 100% of their money
back, but the platform fee charged at capture is **not reversed to the merchant.**

> *"the transaction fee levied by Razorpay at the time of payment capture will not be reversed"*

This has a direct and quantifiable consequence for the failure path, which is worth surfacing rather
than hiding:

**Cost of one merchant-decline (the B5 failure scenario):**

| Step | Money | Fee |
|---|---|---|
| Deposit captured | ₹300 in | −₹7.08 |
| Deposit refunded in full | ₹300 out | ₹0 processing, **fee not returned** |
| Authorisation released | — | ₹0 |
| **Net to customer** | **₹0** | as designed ✅ |
| **Net to merchant** | **−₹7.08** | real, unavoidable cost |

So a graceful failure is not a free failure. It costs the merchant ₹7.08 and the customer nothing —
which is the correct allocation, since the merchant caused it, but it should be stated honestly.

**No longer doc-only, as of dev-logs/014.** The live audit-trail viewer (`web/`) computes this same
figure — `RAZORPAY_MDR_RATE` (2.36%) applied to the amount on every `REFUND_ISSUED` event — and renders
it both as a per-event note ("MDR ₹X not recovered — borne by merchant") and as a running total on the
"Merchant retention" stat card, exactly the number this table works out by hand. This is a number no
event field carries directly; the viewer derives it from the same published rate this document already
sources, the same way it already derives running totals from event *type* rather than reading a
pre-summed field (dev-logs/011).

**This retroactively validates the core design decision.** Brief §6.3 says *"Holds move no money. All
risk is pushed into the cheap, reversible phase."* The fee structure is exactly why that is right: if
`hold_slot` captured money, every expired hold would burn ₹7.08 of irrecoverable MDR. Holds are
frequent and abandonment is normal — an agent exploring options might hold and release five slots. At
zero money movement, that costs ₹0. Had we designed holds as authorisations, the same behaviour would
cost ₹35 per shopping session in pure waste.

> The architecture was chosen on correctness grounds and turns out to also be the cheap one. Worth
> saying out loud.

### Per-booking unit economics

Reference merchant: dermatology clinic. ₹800 consultation, ₹300 deposit, ₹400 no-show fee.

| Scenario | Merchant receives | Razorpay fee | Merchant net |
|---|---|---|---|
| **Booking → attended** (deposit ₹300 + balance ₹500) | ₹800 | ₹18.88 | ₹781.12 |
| **No-show authorisation held, never captured** | — | **₹0** | ₹0 |
| **No-show charged** (deposit ₹300 retained + ₹400 charge) | ₹700 | ₹16.52 | ₹683.48 |
| **Customer cancels >48h** (free tier, full refund) | ₹0 | ₹7.08 sunk | **−₹7.08** |
| **Customer cancels 12–48h** (50% retained) | ₹150 | ₹7.08 | ₹142.92 |
| **Merchant declines** (failure path) | ₹0 | ₹7.08 sunk | **−₹7.08** |

The two negative rows are the honest ones. Free-tier cancellations and merchant declines both cost the
merchant ~₹7 in sunk fees. At the reference clinic's volume this is a rounding error against the
revenue recovered, but it is a real line item and a merchant will ask.

---

## Part 3 — Infrastructure costs

### Tier 0 — Buildathon / demo (what we actually need in the next two weeks)

| Item | Provider | Cost |
|---|---|---|
| App + Postgres | Railway Hobby | **$5/mo** minimum spend; realistic $6–12/mo with a small Node app + Postgres |
| Razorpay test mode | Razorpay | **₹0** — test mode is free, no real money moves |
| TLS certificate | Railway / Let's Encrypt | ₹0 |
| Domain (optional for demo) | Any registrar | ~₹900/yr for a `.com` |
| Error monitoring | Sentry free tier | ₹0 |
| Repo + CI | GitHub free | ₹0 |
| **Total** | | **≈ $6–12/mo (₹530–₹1,060)** |

A Railway free/trial allocation may cover even this. The buildathon costs effectively nothing.

### Tier 1 — One real pilot merchant (~1,200 bookings/month)

| Item | Cost/mo |
|---|---|
| Railway Pro (app, always-on, SSE connections) | $20 |
| Postgres (small managed instance) | $10–15 |
| Domain (amortised) | ₹75 |
| Monitoring (Sentry team / BetterStack) | $0–26 |
| Backups | included / ~$2 |
| **Infrastructure total** | **≈ $32–63/mo (₹2,800–₹5,500)** |

At 1,200 bookings/month that is **₹2.3–₹4.6 of infrastructure per booking.** Negligible against a ₹800
consultation.

### Tier 2 — 50 merchants (~60,000 bookings/month)

| Item | Cost/mo |
|---|---|
| App instances (2–3, load balanced) | $60–100 |
| Postgres (dedicated, replica, PITR backups) | $80–150 |
| Monitoring + logging at volume | $30–80 |
| Object storage (event archive) | $5–15 |
| **Infrastructure total** | **≈ $175–345/mo (₹15,400–₹30,400)** |

**≈ ₹0.26–₹0.51 per booking.** Infrastructure cost per booking *falls* an order of magnitude with
scale, which is what you expect from a stateless app over one database and is a good sign.

### Tier 3 — 500 merchants (~600,000 bookings/month)

| Item | Cost/mo |
|---|---|
| Compute (autoscaled) | $400–800 |
| Postgres (partitioned events table, read replicas) | $400–900 |
| Observability | $150–300 |
| Event archive / cold storage | $50–100 |
| **Infrastructure total** | **≈ $1,000–2,100/mo (₹88,000–₹185,000)** |

At this tier the dominant cost is **people, not servers** — on-call, merchant support, reconciliation
disputes. Budget at least one engineer and one support person before any of the above matters.

**The first real architectural pressure point** arrives here: the append-only `events` table grows
without bound and never gets deleted (that is the point of an audit trail). At ~15 events per booking
and 600k bookings/month, that is ~9M rows/month. The mitigation is date-partitioning the events table
and moving partitions older than the statutory retention period to cold storage. This is designed for
but deliberately **not built** in the buildathon version — see `04-features-and-limitations.md`.

---

## Part 4 — What this earns

### For the merchant (reference clinic, from brief §2.2)

1,200 appointments/month, 32% no-show rate, ₹800 consultation, ₹400 no-show fee.

| Line | Calculation | Monthly |
|---|---|---|
| No-shows today | 1,200 × 32% | 384 slots |
| Revenue lost today | 384 × ₹800 | **₹307,200 evaporating** |
| **Recovery A — no-show charges** | assume 50% of no-shows are chargeable and collect | 192 × ₹400 = **₹76,800** |
| less Razorpay fees | ₹76,800 × 2.36% | −₹1,813 |
| **Recovery B — deposit deterrence** | deposits are documented to reduce no-shows; assume a conservative 5pp drop (32% → 27%) | 60 slots × ₹800 = **₹48,000** |
| **Recovery C — agent-originated bookings** | slots filled that were never going to be booked at all | not modelled — upside |
| **Net monthly recovery (A + B)** | | **≈ ₹122,987** |
| less Latch infrastructure | | −₹5,500 |
| **Net to merchant** | | **≈ ₹117,000/month** |

Against Tier 1 infrastructure of ₹5,500/month, that is a **~21× return** before counting Recovery C,
which is the half the track actually asks about ("grow the merchant's revenue").

⚠️ Recovery B's 5pp assumption is **not sourced** — deposits are widely reported to reduce no-shows but
I have no India-specific figure. It is flagged rather than dressed up. Recovery A alone (₹75,000/month)
carries the case.

### For Razorpay — the strategic number

This is the line that matters to the people judging it. Razorpay earns 2% on payment volume. Latch
creates payment volume **that does not currently exist**:

| New volume type | Monthly, one clinic | Razorpay revenue @ 2% |
|---|---|---|
| No-show charges (today: ₹0, uncollectable) | ₹76,800 | **₹1,536** |
| Deposits on agent-originated bookings | ₹360,000 (1,200 × ₹300) | ₹7,200 (partly cannibalised) |
| **Genuinely incremental** | | **≈ ₹1,500–3,000/clinic/month** |

The no-show line is the honest one: that revenue is **100% incremental**, because today a no-show
produces no transaction at all. There is nothing to cannibalise.

Extrapolating even to a few thousand Razorpay service merchants puts this in the ₹5–10 crore/year
range of new annual payment volume, on a primitive Razorpay does not currently have (brief §3,
Layer 4). That is the commercial argument for the whole project.

---

## Part 5 — What we do not know yet ⚠️

Named explicitly so nobody quotes a number that has not been verified.

| Unknown | Why it matters | How to resolve |
|---|---|---|
| **card manual capture / authorisation pricing** | Razorpay lists subscriptions pricing as "on request". There may be a per-authorisation or per-debit fee on top of 2%, which would change no-show economics | Contact Razorpay sales, or find it in a merchant agreement |
| **Authorisation hold auth amount** | Whether the RBI auth transaction must be ₹1 or can be the deposit itself decides whether booking is one payment or two, and therefore one fee or two | Hands-on test-mode verification (carried over from dev-log 001) |
| **Instant settlement cost** | Service merchants may want faster than T+1; Razorpay charges extra, amount unpublished | Razorpay sales |
| **Deposit → no-show reduction, India** | Recovery B above rests on an unsourced 5pp assumption | Pilot data, or find an Indian study |
| **DPDP compliance cost** | Health-adjacent appointment data under India's DPDP Act may require data residency, consent records, and possibly an audit. Could be a material fixed cost | Legal review before any real merchant |

That last row is the one most likely to become expensive at Tier 2+, and it is a **clinic-specific**
risk — appointment data for a dermatology practice is health-adjacent personal data. It costs nothing
during the buildathon (test mode, synthetic data, no real patients) and should not be hand-waved
afterwards.

---

## Part 6 — Bottom line

| Question | Answer |
|---|---|
| Cost to build and demo this | **≈ $10 / ₹900 total** |
| Cost to run one real merchant | **≈ ₹5,500/month** |
| Cost per booking at 50 merchants | **≈ ₹0.40** |
| AI inference cost | **₹0 — the agent's owner pays it** |
| Cost of one graceful failure | **₹7.08 sunk MDR, borne by the merchant** |
| Value recovered per merchant | **≈ ₹117,000/month** |
| New payment volume for Razorpay per merchant | **≈ ₹1,500–3,000/month, fully incremental** |

---

## Sources

- https://razorpay.com/pricing/
- https://razorpay.com/blog/do-you-get-mdr-back-on-refunds/
- https://razorpay.com/blog/refunds-and-mdr-in-payment-gateways/
- https://razorpay.com/learn/upi-transaction-charges/
- https://razorpay.com/docs/payments/refunds/normal/
- Railway pricing, via srvrlss.io and makerkit.dev calculators (Aug 2026)
- Clinic volume and no-show figures: `agentic-services-transactability-brief.md` §2.2
