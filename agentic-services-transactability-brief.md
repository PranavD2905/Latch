# Agentic Transactability for Service Businesses

### Problem definition, market research, and proposed solution
**Context:** Razorpay AI Buildathon 2026 — Track 01: AI Growth & Agentic Commerce
**Research date:** 23 August 2026
**Geography of focus:** India

---

## 1. The competition context

### 1.1 Track 01 as stated by Razorpay

> **01 — AI Growth & Agentic Commerce**
> Grow the merchant's revenue, and make them sellable to AI buyers.
>
> Build an agent that grows revenue for a merchant on Razorpay test-mode APIs, or that makes a merchant transactable by an AI buyer end to end.
>
> **Why now:** NPCI's UAP and the global protocol race (ACP, AP2, x402) make agent-to-agent commerce the open problem of the year, and Razorpay's in-app pilots are already live.
>
> **Example directions:** Conversational in-app checkout, Agent-readable catalog, Upsell & cross-sell agent, Campaign orchestrator.
>
> **The bar:** Every money action explainable, bounded and gated. Show the audit trail and one failure handled gracefully.

Program parameters: student-only; no resume screening; submission is a public repo + a 5-minute pitch video + architecture. Outcome is a 6 or 12 month in-person AI Builder Internship in Bangalore at ₹75,000/month stipend.

### 1.2 The bar, decomposed

Razorpay's stated bar for Track 01 is one sentence plus one instruction, but it contains **five separable requirements**. Everything in this document — the problem framing, the solution design, the failure scenario — is built against these five clauses, so they are named here once and referenced throughout as **B1–B5**.

| ID | Clause | What it actually demands |
|---|---|---|
| **B1** | *Every money action…* | The unit of evaluation is the **money action**, not the feature. Each individual debit, credit, hold, release, refund and mandate execution must independently satisfy B2–B4 |
| **B2** | *…explainable* | A human must be able to read why a given rupee moved. Not logs — a causal account: which policy, which trigger, which authority |
| **B3** | *…bounded* | A hard ceiling exists that the agent structurally cannot exceed. Detection after the fact does not count; the breach must be impossible, not merely caught |
| **B4** | *…and gated* | Something must stand between intent and execution — a confirmation, a mandate scope, a TTL, a policy check. No money action fires purely on agent inference |
| **B5** | *Show the audit trail and one failure handled gracefully* | Two deliverables. The trail must be **shown**, i.e. legible in the demo, not buried in a database. And the failure must be **handled**, i.e. the system reaches a correct terminal state without human rescue |

**Design consequence.** B3 and B4 together are why this design pushes all risk into a **hold** phase where no money moves. B2 is why the cancellation ladder must be machine-readable and echoed to the agent *before* commitment. B5 is why the merchant-decline path was chosen as the demo failure rather than a staged network error — it is a failure the existing goods-commerce stack has no flow for at all.

A mapping of every design element to these clauses appears in §6.5.

### 1.3 The customer definition that governs everything

Razorpay's customer is **the business holding the Razorpay account** — the clinic, salon, diagnostic lab, gym, tutor, coaching centre, repair service. Track 01's own wording ("grow *the merchant's* revenue", "make *them* sellable to AI buyers") confirms both halves of the track are merchant-benefit framed.

Any candidate idea must pass three tests:

1. **Who installs this?** → A Razorpay merchant.
2. **Whose revenue increases?** → Theirs.
3. **Whose Razorpay account does it run on?** → Theirs, in test mode.

The idea in this document is scoped to pass all three.

---

## 2. The problem

### 2.1 One-sentence statement

An independent Indian service business — a clinic, a salon, a diagnostic lab, a tutor — **cannot be discovered, booked, paid, rescheduled or charged for a no-show by a third-party AI agent**, because no protocol, no AI surface, and no payment provider models the money-and-time semantics of an appointment. The entire agentic commerce stack built in 2025–2026 assumes a physical product with a SKU, a cart, a shipping address and a tracking number.

### 2.2 Why this is a *money* problem, not a scheduling problem

Service inventory is perishable in a way goods inventory never is. An unsold 3pm Tuesday slot does not roll over to Wednesday — it evaporates permanently. A product unsold today is sold tomorrow.

This inverts the economics. For a service merchant, *filling* the slot dominates *pricing* the slot, which makes agent-originated demand disproportionately valuable to exactly this segment — and makes invisibility to agents disproportionately costly.

Two India-specific numbers anchor the size of the leak:

- **32% no-show rate** is reported as the median for Indian outpatient clinics, multi-specialty hospitals and diagnostic chains. For a mid-sized eight-doctor clinic running ~1,200 monthly appointments, that is 384 empty slots per month; at ₹800 average consultation fee, over ₹3 lakh per month in directly lost revenue, before counting the diagnostics, follow-ups and prescriptions that never happen. Scaled to a 200-bed hospital at 12,000 outpatient appointments/month, the same rate burns ₹30 lakh+ monthly.
  *(Source: caller.digital, "AI Voice Agent for Hospital Appointment Booking India | 2026 Guide", June 2026)*
- **55–65% of Indian salon appointments are still booked by phone**, per KPMG and industry surveys, despite the proliferation of booking apps.
  *(Source: tryagentikai.com, citing KPMG India Beauty & Wellness Report + partner audits, 2026)*

Anecdotal but illustrative from the same field research: a South Delhi salon owner put a call tracker on the salon line for one week and recorded 62 missed calls. A Lucknow four-branch salon operator was losing ₹1.8L/month, partly to a 38% no-show rate.

### 2.3 The eight structural properties that break the existing stack

An appointment is not a SKU. These eight properties have no representation in any current agentic commerce protocol:

| # | Property | Why the existing schema fails |
|---|---|---|
| 1 | **Perishable inventory** | An empty slot evaporates; it cannot be restocked or backordered |
| 2 | **Computed, not stocked, availability** | The unit is (service × practitioner × start time × duration × room/chair), derived live from a calendar. `line_items[].quantity` cannot express it |
| 3 | **Money split across time** | Deposit now, balance at service. UCP carries one `totals` block and one payment event |
| 4 | **Cancellation as a priced ladder** | >48h free, 12–24h 50%, <12h 100%. No protocol field exists for a time-dependent penalty schedule. An agent cannot honour a policy it cannot read |
| 5 | **No-show is a charge, not a refund** | You debit a customer who received nothing. Requires a pre-authorised mandate taken at booking and executed later |
| 6 | **Reschedule is the dominant post-purchase action** | Not return, not refund — a *move*: same money, different time, possibly different practitioner, possibly a price delta |
| 7 | **The merchant can decline after payment** | A doctor refuses a booking; a stylist calls in sick. Goods commerce has no "seller rejects a paid order" flow |
| 8 | **Fulfilment is the customer travelling to you** | No shipping address, no carrier, no tracking number, no `delivered` event. The entire fulfilment half of the goods schema is dead weight |

---

## 3. Market research — the occupancy map

Four layers were examined. The finding is that each layer is either empty, or occupied by something pointing in a different direction.

### Layer 1 — The protocols: no services primitive exists

**Universal Commerce Protocol (UCP)** — Google + Shopify, announced at NRF, 11 January 2026. Open source, Apache 2.0, at ucp.dev and on GitHub.

Verified directly from ucp.dev (August 2026): **UCP has exactly three verticals — Shopping, Lodging, and Food.**

- Shopping co-developers: Google, Shopify, Etsy, Wayfair, Target, Walmart, Amazon, Microsoft, Meta, Salesforce, Stripe
- Lodging co-developers: Amadeus, Booking.com, Expedia Group, Google, Hilton, Marriott, Trip.com
- Food co-developers: DoorDash, Google, Square, Toast, Uber Eats

There is **no appointments/services/local-services vertical**, and none announced. Lodging and Food are both marked "Detailed specifications coming soon."

The Shopping schema is unambiguously goods-shaped. A UCP checkout object carries:
- `fulfillment.methods[].type: "shipping"`
- `destinations[]` as postal addresses (`street_address`, `postal_code`, `address_country`)
- Order events of `type: "delivered"` with `tracking_number` and `tracking_url`

The Order capability's `adjustments` array supports types: `refund`, `return`, `credit`, `price_adjustment`, `dispute`, `cancellation`. **`reschedule` is absent** — the single most common post-booking action in the appointment economy has no event type.

Further UCP gaps documented independently:
- Returns and refunds were **not in the initial capability set**; the Order capability covers post-purchase notifications but the return *flow* is not standardised. Return initiation and refund processing are explicitly future capabilities.
- **No optimistic concurrency control.** A `PUT` replaces the entire session state and last writer wins; there is no ETag or version token. The spec author expects this to be the first thing needing amendment as multi-actor checkout becomes common.

*(Sources: ucp.dev homepage and /latest/specification/order/; deveshshetty.com "Commerce Doesn't Have a Protocol (Yet): Inside UCP", Feb 2026; wearepresta.com UCP implementation guide, Aug 2026; developers.google.com/merchant/ucp)*

**Agentic Commerce Protocol (ACP)** — OpenAI + Stripe, launched September 2025, open source.

ACP is checkout-centric. Its Delegated Payment Spec issues Shared Payment Tokens — single-use, time-bound, amount-restricted credentials scoped to a specific merchant. Some descriptions of ACP list "buying, booking, or quoting" as supported commerce actions, but no services schema was ever published.

ACP's consumer surface has retreated:
- **OpenAI shut down Instant Checkout entirely in March 2026.** Only ~8% of US ChatGPT adults tried it; only about a dozen Shopify merchants integrated; OpenAI never built sales tax collection or fraud prevention. ACP has been pivoted toward product discovery and merchant-controlled app experiences.
- The **travel attempt failed specifically**: users happily researched trips inside ChatGPT but left to book somewhere they trusted. Native checkout for travel was pulled by early March 2026.
- Major retailers (Target, Sephora, Nordstrom, Lowe's, Best Buy, Home Depot, Wayfair) have integrated ACP **for discovery only**.

*(Sources: gladly.ai "Agentic commerce protocols MCP ACP and UCP explained", July 2026; tourismtribe.com, June 2026; modernretail.co "What went wrong with ChatGPT's Instant Checkout", March 2026; netalico.com, May 2026)*

**Other protocol layers (for completeness):**
- **AP2** (Google + PayPal): cryptographically verifiable mandates — the trust/authorisation layer. Sits one step before checkout.
- **x402** (Coinbase): stablecoin settlement over HTTP 402 for machine-to-machine and API payments. Not relevant to physical services.
- **MCP**: the tool-discovery transport. UCP explicitly supports REST, JSON-RPC, MCP, A2A and AP2 as transports.
- **Web Bot Auth / Visa Trusted Agent Protocol / Mastercard Agent Pay / Cloudflare PACT**: the agent-identity layer. Cloudflare-led, IETF draft, with Anthropic, OpenAI, Perplexity and Google bots supported; Shopify ships Web Bot Auth keys in the merchant admin.

**Layer 1 conclusion: EMPTY.** No protocol anywhere models an appointment.

---

### Layer 2 — The AI surfaces: booking exists, transacting does not

Services *did* become agent-bookable in 2026 — but the shape of what shipped is the key finding.

**Timeline:**
- **29 April 2026** (PCWorld hands-on test): Claude surfaced a live Resy availability grid for a restaurant and then stated it could not complete the booking. ChatGPT's agent mode spent five minutes clicking through OpenTable's web UI, selected the wrong party size, and handed control back to the user.
- **~Late July 2026:** Yelp content partnership brings reviews, ratings, photos and business attributes into ChatGPT answers.
- **10 August 2026:** Yelp enables ChatGPT users to book a table or join a waitlist at thousands of US and Canadian restaurants without leaving the chat. Resy (American Express) launches Resy Reservations in ChatGPT for US restaurants the same week. OpenTable powers recommendations globally.
- Gemini + OpenTable operates via **Reserve with Google**.

**Three constraints define the boundary of what was solved:**

1. **Gatekept, not open.** Yelp's integration only covers restaurants using **Yelp Guest Manager**. Eligibility to appear in ChatGPT's booking flow is determined by *software adoption*, not by search optimisation, content strategy, or anything the merchant can independently do. A restaurant not on OpenTable, Resy or Yelp Guest Manager does not exist to ChatGPT.
2. **Restaurants only, US/Canada only, English only.** Gemini's OpenTable connector requires the user to be 18+ and in the US or UK, signed in with a personal Google Account, English only, and is unavailable in Gems or Gemini Live. India is not in scope for any of these.
3. **No money, and no reverse flow.** Once the reservation exists, ChatGPT is finished. Changes and cancellations must happen back on Yelp, OpenTable or Resy. The chat cannot cancel — and a no-show can mean an account strike or a fee.

None of the three partners published a protocol name, endpoint spec, or schema. The interaction shape (an interactive card rendering in-conversation, holding state across turns, refreshing live inventory, submitting a form) suggests OpenAI's Apps SDK, built on MCP.

**The decisive observation:** a restaurant reservation is a **free option with no payment leg**. It is the easiest possible service to make agent-bookable *precisely because no money moves*. The moment a service requires a deposit, carries a cancellation penalty, or charges for a no-show, none of this machinery applies.

*(Sources: explainx.ai, August 2026; techwyse.com, August 2026; komando.com, August 2026; support.google.com/gemini/answer/17090712)*

**Layer 2 conclusion: BOOKING ≠ TRANSACTING.** The surfaces solved the zero-money case, in one geography, through closed gatekeepers.

---

### Layer 3 — Vertical SaaS: saturated, but the arrow points inbound

This is the layer where the idea is most likely to be *mistaken* for something that already exists. Precision matters.

**Zenoti** (global enterprise, ~₹15,000+/month/branch in India, used by Lakme, Geetanjali Salon and Gulf chains):
- Serves 30,000+ beauty, wellness and fitness businesses across 50+ countries
- **AI Receptionist**: handles calls the front desk misses — booking, cancelling and rescheduling automatically, then confirming appointments before they become no-shows. Claims 1 in 3 missed calls converted, ~35% of otherwise-unanswered calls recovered monthly, 25% of those with upsells. Graceful human handover.
- **AI Workforce**: a set of specialised agents — a marketing agent optimising SEO/ads/listings/review responses, a lead agent qualifying and nurturing, a voice agent answering calls and booking, a lifecycle agent handling engagement, upsells, loyalty and rebooking.
- SmartBot online booking across web, mobile and chat; branded flows; provider-matching engine.

**Indian salon/spa CRM field** (₹799–₹8,000+/month): Cleomitra (AI CRM + WhatsApp Business API + Instagram DM, from ₹999/mo), Invoay (7,000+ Indian salons, AI POS angle), Zylu (AI-powered, zero-commission marketplace, WhatsApp API marketing), Dingg (India-first, strong WhatsApp + UPI, ₹999–₹2,499/mo), MioSalon (₹999–₹2,500/mo), Salonist, EasySalon.

**Indian clinic/hospital AI voice agents**: Caller Digital and others, offering real-time HIS/EMR integration, multi-channel confirmation (voice + WhatsApp + SMS fallback), human handoff paths, and DPDP-aligned data handling with Indian data residency.

**Global salon voice AI**: Famulor, Qlient.ai, Voksha — booking directly into Mindbody, Vagaro, Treatwell, Booksy, Fresha, Boulevard, GlossGenius or Google Calendar. Industry research cited: ~69% of salon/spa customers have abandoned a booking attempt because they could not reach a human.

**The critical distinction:**

Every product above is **inbound**: *the merchant's own AI picks up a phone call from a human.* It is a receptionist replacement. Not one of them exposes an endpoint that lets ChatGPT, Gemini, Copilot, Claude or a user's personal agent transact with the business. Zenoti has an AI that answers your call; it has no `/.well-known/ucp` manifest, no MCP server, no published agent-facing API.

```
What exists:     [Human] --phone--> [Merchant's own AI] --> [Merchant's calendar]
What's missing:  [User's agent] --protocol--> [Merchant] --> [booking + money]
```

**Layer 3 conclusion: "AI answers your phone" is SATURATED. "Agents can transact with you" is UNTOUCHED.** These are opposite arrows. Conflating them is the single biggest presentational risk to this idea.

---

### Layer 4 — Razorpay: does it have this? **No. Explicitly not.**

Checked against: razorpay.com/sprint/26 (the full 100+ launch list from FTX'26), razorpay.com/agentic-payments, razorpay.com/agent-studio, and the Razorpay MCP tools reference.

**What Razorpay has shipped in the agentic space:**

| Product | Description |
|---|---|
| **Agentic Payments — In-App Chats** | Turn a merchant chatbot into an agent that completes purchases autonomously |
| **Agentic Payments — on LLMs** | Conversational product discovery + UPI payments inside LLMs |
| **Razorpay for ChatGPT Apps** | Upload catalogue, go live with native checkout inside ChatGPT |
| **Voice Payments** | Approve and complete transactions over a call |
| **Razorpay MCP 1.0 + Remote MCP** | 35+ tools: Payments (5), Payment Links (6), Orders (5), Refunds (6), QR Codes (7), Settlements (6), Payouts (2), Standard Checkout. Endpoint `https://mcp.razorpay.com/mcp` |
| **Agent Studio** | Dispute Auto-Responder, RTO Shielder, Cashflow Insights (RTO pattern analysis by pincode/product/customer), Subscription Recovery, abandoned-cart re-engagement |
| **Agentic Platform** | Agentic Onboarding (KYC), Ray Smart Assist, Agentic Integration, Ray Customer Support, Agentic Dashboard, Razorpay Dashboard on Claude |
| **Agentic Business Banking** | Insights, Receivables, Payouts, Bookkeeping, Reporting agents |
| **UPI Reserve Pay** | Customers pre-approve a spending limit against a brand and debit against it until exhausted — no repeated approvals or PIN entry |
| **Other mandate infra** | UPI Autopay + ₹1 registration, UPI Mandate Cancellation APIs, Intelligent Retry Engine, higher card auto-debit limits (₹1 lakh) |
| **Biometric Card Authentication** | RBI-compliant, with Mastercard — fingerprint/Face ID replacing OTP |
| **Payments for Builders** | n8n node, Replit, Vercel |

**Razorpay's agentic partnerships:**
- **Claude / Anthropic + NPCI** — agentic payments for Zomato, Swiggy, Zepto (India AI Impact Summit, Delhi)
- **OpenAI** — first integration unveiled at Global Fintech Festival 2025
- **Agent Studio and Agentic Experience Platform** — both built on Anthropic's Claude Agent SDK, launched at FTX'26, March 2026
- **Sarvam AI** — conversational layer handing off to Razorpay payment execution via MCP; decoupled authorisation and context isolation against prompt injection
- **Gnani.ai** — "first agentic AI collections platform capable of completing payment transactions during live customer calls", via Razorpay MCP; Gnani processes 10M+ calls daily
- **superU AI** — real-time agentic payment system for voice-initiated transactions without human input at the point of payment. Razorpay cites 1B+ monthly voice searches in India. Stated use cases include booking transport and paying utility bills
- **Mastercard** — biometric card authentication for AI-driven commerce
- **In-app agentic pilots** — Vodafone Idea (GFF 2025, recharge), Zomato, PVR INOX, Bluestone, Honasa/The Derma Co (FTX 2026)

**What Razorpay does NOT have:**

- No slot, appointment, or booking primitive anywhere in the API or MCP tool surface
- No deposit-plus-balance money object
- No cancellation-policy schema
- No no-show charge mechanism
- No reschedule event type
- No services vertical in any agentic product
- Agent Studio's agent catalogue is entirely e-commerce and subscription shaped (RTO, chargebacks, cart abandonment, subscription retries)

**Razorpay's current relationship with service merchants is as a dumb payment leg:**
- Appointment schedulers list Razorpay as a supported gateway: MioSalon, Zoho Bookings, BookingPress, Booknetic, Yzzy, PracFlow
- Razorpay ↔ Acuity Scheduling is wired through **Zapier**, with "Invoice Paid" / "Payment Captured" / "Payment Link Paid" as triggers and "New appointment scheduled" / "Appointment rescheduled" as separate unrelated events

That Zapier detail is the thesis in miniature: **today the calendar and the money are two systems glued together by a webhook. An agent cannot reason about them as one object.**

**Layer 4 conclusion: NOT BUILT BY RAZORPAY.** UPI Reserve Pay is the correct underlying primitive, but no booking product has been built on it.

---

## 4. Competitive occupancy summary

| Capability | Who owns it | Built by Razorpay? | Available in India? | Status |
|---|---|---|---|---|
| Goods checkout by agent | UCP (Google/Shopify), ACP (OpenAI/Stripe) | No (Razorpay integrates) | Partial | Solved |
| Lodging booking by agent | UCP Lodging — Marriott, Hilton, Expedia, Booking.com, Amadeus, Trip.com | No | No | Spec pending |
| Food ordering by agent | UCP Food — DoorDash, Square, Toast, Uber Eats | No | No | Spec pending |
| Restaurant reservation by agent | OpenTable, Resy, Yelp Guest Manager via ChatGPT/Gemini | No | No (US/CA/UK only) | Solved, no money |
| AI receptionist answering calls | Zenoti, Cleomitra, Invoay, Zylu, Dingg, Famulor, Voksha, Caller Digital | No | Yes | Saturated |
| Agent identity verification | Cloudflare Web Bot Auth, Visa TAP, Mastercard Agent Pay, PACT | No | Partial | Occupied |
| Delegated payment mandates | AP2, UPI Reserve Pay, UPI Circle, NPCI UAP | **Yes** (Reserve Pay) | Yes | Occupied |
| Post-purchase returns automation | Narvar NAVI, Loop Returns, AfterShip, Optoro | Partial (RTO Shield) | Partial | Occupied |
| **Appointment booking + payment by third-party agent** | **Nobody** | **No** | **No** | **OPEN** |

---

## 5. The novelty claim

The novelty is **not** "an AI that books appointments" — that is crowded and would be correctly rejected.

The novelty is **the money-and-time semantics of a service transaction, expressed in a form an arbitrary third-party agent can execute against.**

Specifically, these primitives do not exist in any protocol, any AI surface, any vertical SaaS product, or at Razorpay:

1. A **slot hold with a TTL** — reserve capacity without moving money
2. A **two-stage money object** — deposit at booking, balance at service
3. A **machine-readable cancellation ladder** — a time-dependent penalty schedule an agent can read, echo to the user, and honour
4. A **no-show charge authorisation** — a mandate captured at booking, executed later against a customer who received nothing
5. A **reschedule event** — a move rather than a refund, preserving the money while changing time and possibly practitioner
6. A **merchant-decline path** — the seller rejecting an already-confirmed, already-paid slot

Novelty scoring:

| Dimension | Assessment | Reasoning |
|---|---|---|
| Protocol-level novelty | **High** | UCP has Shopping/Lodging/Food only; no appointments primitive exists anywhere |
| Razorpay overlap | **None** | Verified across Sprint '26, Agent Studio, MCP tools, agentic-payments pages |
| India relevance | **High** | Large Razorpay service-merchant base; 32% clinic no-show rate; 55–65% of salon bookings by phone |
| Defensibility vs incumbents | **Medium** | Zenoti et al. point inbound-at-humans; the surface-level pitch sounds similar and must be differentiated explicitly |
| Demo-ability | **Medium-High** | Deposit → no-show charge → reschedule is a legible five-minute narrative |
| Fit to Track 01 brief | **High** | Directly answers "make a merchant transactable by an AI buyer end to end" for a non-e-commerce merchant |

---

## 6. The proposed solution

### 6.1 Shape

A **service-transaction layer built on Razorpay test-mode APIs** that exposes an individual service merchant — clinic, salon, diagnostic lab, tutor — as transactable by any third-party AI agent, with the money semantics as the core rather than the calendar.

Delivered as an **MCP server**, because Razorpay has already normalised MCP as its agent interface (Razorpay MCP 1.0, Remote MCP, Sarvam handoff, Gnani.ai integration, Claude/ChatGPT connectors), making this idiomatic rather than novel-for-novelty's-sake.

### 6.2 Tool surface

Every tool is specified against **B1** — the money action is named explicitly, its **bound (B3)** is a hard ceiling, and its **gate (B4)** is the precondition without which it cannot fire.

| Tool | Behaviour | Money action | Bound (B3) | Gate (B4) |
|---|---|---|---|---|
| `find_slots` | Returns available (service × practitioner × start × duration) tuples computed live from the merchant calendar | None | n/a | n/a |
| `get_policy` | Returns the machine-readable cancellation ladder, deposit rule, and no-show terms | None | n/a | n/a |
| `hold_slot` | Reserves capacity with a TTL (e.g. 10 minutes). Idempotency-keyed | **None — this is the point** | Max concurrent holds per agent; TTL auto-expiry | Slot must be free at request time |
| `confirm_with_deposit` | Converts hold to booking, captures deposit, registers the no-show mandate | Deposit capture | Policy deposit amount; Reserve Pay mandate ceiling | Live, unexpired hold + policy acknowledged by agent |
| `reschedule` | Moves an existing booking. Same money, new time/practitioner, optional price delta | Price delta only | Delta capped at original booking value | Target slot free + ladder permits move at this time-to-appointment |
| `cancel` | Applies the cancellation ladder based on time-to-appointment | Refund or partial retention | Retention capped at ladder tier for the actual timestamp | Booking exists + ladder tier computed from server clock, not agent claim |
| `charge_no_show` | Executes the pre-authorised mandate after a missed appointment | Debit | Mandate ceiling registered at booking | Appointment start time elapsed + merchant marked non-attendance |

**On B3 specifically:** the bounds above are enforced server-side against the merchant's policy record and the server clock. An agent cannot raise a ceiling, reclassify a ladder tier, or assert an earlier cancellation time — the breach is structurally unavailable, not detected afterwards.

### 6.3 Money architecture

- **Holds move no money.** All risk is pushed into the cheap, reversible phase. Nothing irreversible happens until the merchant, the slot and the policy have all confirmed.
- **Deposit via UPI Reserve Pay.** The residual pre-approved limit carries the no-show authorisation, so the no-show charge is a debit against an existing consented ceiling rather than a fresh unauthorised pull. This is the piece that makes the design Razorpay-native rather than payments-agnostic.
- **Every money action idempotency-keyed**, so an agent retry after a network failure cannot double-charge or double-book.
- **The cancellation ladder is returned to the agent before commitment**, so the agent can tell the user "cancel before Thursday 3pm or you're charged ₹400" without a human ever explaining the policy. This is what makes the transaction *explainable* in Razorpay's sense.

### 6.4 The failure scenario (satisfies B5)

B5 asks for "one failure handled gracefully." In this design the failure is **intrinsic to the domain rather than staged for the demo** — it is the merchant-decline path, property #7 in §2.3, which goods commerce has no flow for at all.

> An agent books a 4pm Thursday dermatology consult for its user. Deposit of ₹300 captured. On Wednesday the practitioner calls in sick and the merchant declines the already-confirmed, already-paid slot.
>
> The system: releases the slot, refunds the ₹300 deposit in full (merchant-caused cancellation ⇒ ladder does not apply), revokes the no-show mandate, computes the next three slots matching the original constraints (same service, comparable practitioner, within the user's stated window), and pushes a structured reschedule offer back to the originating agent.
>
> **Terminal state reached without human rescue. Net customer cost ₹0. No orphaned mandate, no stranded hold, no manual refund ticket.**

**The audit trail as shown in the demo (satisfies B2 and B5):**

```
14:02:11  HOLD        slot=thu-1600 practitioner=dr_rao ttl=10m
                      gate: slot free at request  |  bound: 3 concurrent holds/agent
14:03:48  POLICY_ACK  agent read ladder v4 (>48h free / 12-48h 50% / <12h 100%)
14:04:02  CAPTURE     ₹300 deposit
                      gate: live hold + policy acked  |  bound: ₹300 policy deposit
                      authority: Reserve Pay mandate m_8812, ceiling ₹1,500
11:20:33  DECLINE     source=merchant reason=practitioner_unavailable
                      ladder NOT applied — cause attributed to merchant, not customer
11:20:34  REFUND      ₹300 → original instrument (ref rfnd_4471)
11:20:34  REVOKE      mandate m_8812 released, remaining ceiling ₹1,200 returned
11:20:35  OFFER       3 alternate slots pushed to originating agent
                      net customer cost ₹0 | net merchant retention ₹0
```

Each line names the money action (**B1**), the reason it was permitted or refused (**B2**), the ceiling it ran against (**B3**), and the precondition it cleared (**B4**). A judge reading this line-by-line can reconstruct every rupee without access to the database.

### 6.5 Bar compliance mapping

| Bar clause | How the design satisfies it |
|---|---|
| **B1 — every money action** | Seven tools, four of which move money. Each is individually specified with its own bound and gate in §6.2. There is no composite "book and pay" call that hides sub-actions |
| **B2 — explainable** | The cancellation ladder is machine-readable and must be acknowledged by the agent before commitment, so the agent can state the consequence to the user in advance ("cancel before Thursday 3pm or you're charged ₹400"). Every trail entry carries a reason and an authority reference, not just an amount |
| **B3 — bounded** | Two independent ceilings: the policy deposit amount and the Reserve Pay mandate ceiling. Both enforced server-side against the merchant's policy record. Ladder tiers computed from the server clock, so an agent cannot assert a more favourable cancellation time. Breach is structurally unavailable, not detected afterwards |
| **B4 — gated** | No money action fires on agent inference. `confirm_with_deposit` requires a live unexpired hold plus policy acknowledgement. `charge_no_show` requires elapsed start time plus explicit merchant non-attendance marking. `cancel` recomputes the tier server-side. Holds expire automatically rather than persisting on agent silence |
| **B5 — audit trail shown** | The trail above is a first-class demo artifact, rendered legibly, not a log file |
| **B5 — one failure handled gracefully** | Merchant-decline of a confirmed, paid slot — a failure mode with no equivalent in goods commerce. Reaches correct terminal state autonomously: slot released, deposit refunded, mandate revoked, alternatives offered |

**Why the bar favours this idea specifically.** For most Track 01 submissions the bar is a compliance exercise bolted onto a happy path — a contrived failure inserted to satisfy the last clause. Here the causality runs the other way: **a service transaction is unsafe without B3 and B4**, because a no-show charge is a debit against someone who received nothing, and a cancellation penalty is money retained from someone who bought nothing. Bounds and gates are not decoration on this design; without them the product is indefensible. The bar and the domain want the same architecture.

### 6.6 Measurable outcomes for the merchant

- **Slots filled** that would otherwise have evaporated (perishable inventory recovered)
- **No-show revenue recovered** via executed mandates
- **Deposit-induced no-show reduction** (the deposit itself changes behaviour)

Both primary metrics are denominated in rupees and attributable to the merchant, satisfying the "grow the merchant's revenue" half of the track.

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **"Isn't this just Calendly + a Razorpay payment link?"** | High | Prepared one-liner: *Calendly lets a human book and pay as two separate acts; this lets an agent hold a slot, take a deposit, honour a cancellation ladder, and charge a no-show as one bounded transaction with an audit trail.* If this cannot be said in 30 seconds the idea dies early |
| **Confusion with Zenoti / AI receptionists** | High | Lead with the direction of the arrow. This is not the merchant's agent talking to humans; it is making the merchant reachable by everyone else's agents |
| **Collision with Track 01's excluded "agent-readable catalog" direction** | Medium | Centre the pitch on money semantics — deposits, ladders, no-show charges, reschedules — not on exposing a service list. The catalogue is table stakes; the transaction is the product |
| **UCP announces a services vertical** | Medium | UCP went Shopping → Lodging → Food; local services is a plausible fourth. Re-check the UCP GitHub and roadmap before committing and again before submission |
| **Zenoti or a vertical SaaS ships an MCP endpoint** | Medium | Would validate the thesis but compress the window. Differentiate on the money layer, which vertical SaaS does not own — they sit on top of a gateway |
| **Razorpay ships this themselves** | Medium | Sprint '26 was a 100-launch event. Check the Razorpay changelog and blog immediately before submission |
| **UPI has no native authorisation/hold step** | Medium | Unlike cards, UPI is an instant debit. Verify what the reserve phase maps to in test mode — Reserve Pay, manual capture, or a simulated escrow — and state the constraint openly in the pitch rather than letting a judge discover it |

---

## 8. Appendix A — Track 01 gaps evaluated and rejected

For context on why this gap was selected. All were assessed against the same three-question customer test in §1.3, and against the bar clauses B1–B5 in §1.2.

| Gap | Verdict | Reason |
|---|---|---|
| Cross-merchant basket orchestration + atomic rollback | **Rejected** | Technically strong (distributed saga, compensating transactions, no protocol support — ACP is single-item, UCP has no concurrency control) but fails the customer test: it serves the shopper, not any one Razorpay merchant, and exists to spread money across competitors |
| Agent identity — "is this a shopping agent or a scraper?" | **Rejected** | Occupied by Cloudflare Web Bot Auth (IETF draft), Visa Trusted Agent Protocol, Mastercard Agent Pay, Cloudflare PACT (backed by Google, Microsoft, Mozilla, Shopify), Shopify admin keys. NPCI UAP will cover the India registry layer |
| Delegated payment mandates | **Rejected** | Occupied at protocol level by AP2 and at product level by Razorpay's own UPI Reserve Pay; NPCI UAP extends UPI Circle's delegation model to AI agents |
| Agentic returns / reverse flow | **Rejected** | Narvar NAVI (NRF, Jan 2026) is an agentic post-purchase assistant resolving delivery issues, returns, refunds and exchanges, with an MCP agent orchestrating identity, policy and inventory, built on 74B consumer touchpoints and 2B tracked parcels. Loop Returns (exchange-first flows + order editing + Loop Intelligence), AfterShip, Optoro cover adjacent ground. Razorpay has RTO Shield, Cashflow Insights RTO analysis, ClickPost instant refunds, wallet-based refunds, 6 refund MCP tools |
| Delegation evidence for disputes | **Rejected for Track 01** | Genuinely open — no jurisdiction has enacted agentic purchasing regulation as of 2026; AP2 produces mandate records but networks and issuers are still deciding what counts as sufficient proof; CFPB's Jan 2026 advisory held that consumer dispute rights survive delegation; Amex committed to covering erroneous purchases by registered agents. But the natural artifact is a dispute response — Track 02 territory, and Razorpay already ships a Dispute Auto-Responder |
| Agent-attributable revenue analytics | **Rejected** | Real (agent purchases arrive via API, so no JavaScript fires, no cookies set, no thank-you page loads; payment infrastructure carries no agent-vs-human signal) but Shopify Agentic Storefronts shipped native attribution to 5.6M stores in March 2026 and Tealium ingests ACP webhooks. Diagnostic rather than transactional; demos poorly against the bar |
| Concurrency across agent surfaces (overselling) | **Held as backup** | Strong merchant-side fit; agents check out in parallel at machine speed against one inventory. UCP's last-writer-wins session model confirms the protocol gap |
| Agent funnel diagnostics ("why agents don't buy from you") | **Held as backup** | Agentic conversion lags ~86% behind affiliates because merchant infrastructure was not built for agents; agents punish unstructured data. But diagnostic, not transactional |
| B2B sell-side quoting for Indian MSMEs | **Held as backup** | Forrester expects ~20% of B2B sellers to face agent-led quote negotiation by end-2026; suppliers with PDF pricing become invisible to procurement agents; funded players (Lio, $30M a16z, March 2026) are buy-side. Hard to demo in five minutes |

---

## 9. Appendix B — Wider context data points

**Agentic commerce scale and trajectory:**
- Shopify: AI-attributed orders grew 11x between January 2025 and March 2026; AI-referred traffic up 7x in the same period
- Shopify Agentic Storefronts activated for all eligible merchants on 24 March 2026 — 5.6M stores gaining access to ChatGPT, Microsoft Copilot, Google AI Mode and Gemini
- Tatcha (early Shopify Agentic Storefronts adopter): 3x conversion rate, 38% AOV uplift, 11.4% of total Shopify store revenue attributed to AI-assisted conversations
- Adobe Analytics: 4,700% YoY growth in AI-driven visits to US retail sites in 2025; AI-referred traffic to US retail up 393% YoY in Q1 2026
- eMarketer: ~$20.9B of 2026 retail spending attributed to AI platforms, ~4x the 2025 level
- AI-driven sessions still sit below 0.2% of total ecommerce traffic — growth is from a very small base
- Consumer adoption ~39%; agentic conversion currently ~86% worse than affiliates
- Gartner top strategic prediction for 2026: 90% of B2B buying flows through AI agents by 2028
- IDC (August 2026): 80% of B2B technology buyers already use AI agents in purchasing

**India payments context:**
- UPI processed 22.71 billion transactions worth ₹28.92 trillion in June 2026; 63.5% peer-to-merchant
- NPCI is developing the **Unified Agent Protocol (UAP)** to register, verify and authorise AI agents within the UPI ecosystem without changing underlying rails. Extends the UPI Circle delegated-payments model to treat AI agents as authorised delegates. Requires RBI approval; not yet launched. NPCI would maintain logs of agentic transactions
- Expected first use cases: low-consideration, high-frequency purchases — groceries, routine bill payments
- Indian industry participants flagged dispute management as the core unsolved concern for agentic UPI: the ability to review what happened when a machine goes rogue
- Razorpay cites 1B+ voice searches per month in India

**Protocol landscape (composition, not competition):**
- AP2 establishes that a human authorised the action
- ACP and UCP carry out merchant-side checkout
- Visa/Mastercard supply the scoped credential the rail accepts
- x402 handles agent-to-agent settlement at the edges
- Web Bot Auth underpins agent identity for Visa TAP and Mastercard Agent Pay
- MCP is the tool-discovery transport underneath much of it

---

## 10. Sources

**Primary / first-party**
- razorpay.com/buildathon — Track 01 specification
- razorpay.com/sprint/26 — full FTX'26 launch list (100+ launches)
- razorpay.com/agentic-payments, razorpay.com/agent-studio
- razorpay.com/docs/mcp-server/tools-reference, /docs/mcp-server/remote
- ucp.dev — homepage, verticals, /latest/specification/order/, /latest/specification/reference/
- developers.google.com/merchant/ucp, developers.google.com/merchant/ucp/guides/orders
- support.google.com/gemini/answer/17090712
- zenoti.com — AI Receptionist, AI Workforce, online booking, pricing pages
- corp.narvar.com — NAVI press release, Narvar Agentic

**Secondary**
- Business Standard, Outlook Business, Medianama, VisionIAS, ClearingPost — NPCI UAP (July 2026)
- Business Standard, The Paypers, YourStory, Analytics India Magazine — Razorpay Agent Studio, Claude/NPCI, Gnani.ai, Sarvam, superU AI
- Modern Retail, Gladly, Tourism Tribe — ACP / Instant Checkout shutdown
- explainx.ai, techwyse.com, komando.com — ChatGPT restaurant reservations, August 2026
- deveshshetty.com, wearepresta.com, aiadvantageagency.com, brambles.ai, netalico.com, clustova.com, joinhexagon.com — UCP/ACP analysis
- eco.com, orium.com, honeyb.ai, agentcommerce.substack.com — protocol stack analysis
- chargeflow.io, justt.ai, fraudbeat.com, chargebacks911.com, trustsphere.ai — agentic liability and disputes
- caller.digital, tryagentikai.com, codingclave.com, sandcsalons.com, voksha.com, famulor.io — Indian service-business AI and salon/clinic economics
- MetaRouter, Commercetools, digitalapplied.com, opascope.com, atxp.ai — agentic commerce statistics and attribution
- Cloudflare blog, stellagent.ai, sherocommerce.com — Web Bot Auth, agent identity
- Deloitte, Forrester (via elogic.co, joinhexagon.com, mohammedshehu.com) — B2B agentic procurement
- pango.ai, minami.ai — post-purchase platform comparisons

---

*All findings verified as of 23 August 2026. The agentic commerce landscape is moving on a weekly cadence; re-verify Razorpay's changelog, the UCP roadmap, and the vertical SaaS agent announcements before relying on any occupancy claim in this document.*
