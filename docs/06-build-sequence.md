# Latch — Build Sequence

**Status:** Proposed
**Date:** 23 August 2026
**Window:** 1–2 weeks, targeting a 2–4 week quality bar

---

## The sequencing principle

**Vertical slices, not horizontal layers.**

The tempting order is: build the database, then the domain, then the adapters, then the UI. It is
tidy, and on a fixed deadline it is the order that kills submissions — nothing is demonstrable until
everything is finished, and if day 10 arrives with the UI unstarted, there is no demo at all.

Instead each slice cuts through every layer and ends with something that runs. **By end of Slice 3 —
roughly day 4 — the complete failure path works end to end.** That is the submission's core argument.
Everything after that deepens a thing that already exists.

The risk profile matters too: the slices are ordered so the *most uncertain* work (Razorpay authorisation
registration, which dev-log 001 flagged as unverified) happens early enough that discovering a problem
still leaves time to respond.

Each slice had a **self-contained session prompt**, so it could be run in a fresh Claude session without
losing context — the prompts themselves aren't part of this repo (kept local, not published), but the
slice structure below is what they drove.

---

## Slice 0 — Skeleton and event store · ~day 1

**Ends with:** an event can be appended and a booking state folded back out of it.

- Repo, `tsconfig` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Postgres via Drizzle; `events` table (append-only), `bookings` projection
- The partial unique index — **written now**, because it shapes everything downstream
- `Money` branded paise type; `Clock` port with system and frozen implementations
- Event types with the four mandatory fields, and the constructor that refuses to omit them

**Done when:** a unit test appends `HOLD_CREATED` and folds the booking to `HELD`.

---

## Slice 1 — Happy path, no real money · ~day 2

**Ends with:** an agent can search, hold, and confirm — against a fake payment provider.

- `find_slots` — computed from working hours minus live bookings
- `get_policy` — the versioned ladder, returned machine-readably
- `hold_slot` — TTL, idempotency, concurrent-hold limit
- `confirm_with_deposit` — against `FakePaymentProvider`
- MCP server over stdio; connect from Claude Code locally
- Ladder evaluator + **boundary tests on a frozen clock** (47h59m vs 48h00m)

**Why fake payments first:** it proves the state machine is correct before any network variable enters.
When Razorpay is wired in next and something breaks, the domain is already known-good.

**Done when:** a real agent, over MCP, completes a booking end to end locally.

---

## Slice 2 — Real Razorpay, deposit leg · ~day 3

**Ends with:** a real test-mode deposit is captured.

- `RazorpayPaymentProvider` implementing the `PaymentProvider` port
- Orders API, capture, refund
- Idempotency keys mapped onto Razorpay's own
- Integration tests against test mode

**Done when:** a deposit appears in the Razorpay test dashboard, and `DEPOSIT_CAPTURED` carries the
real `payment_id` as its authority.

---

## Slice 3 — The failure path · ~day 4 ⭐

**Ends with: the submission's core argument works end to end.**

- Merchant API: `decline_booking`
- Domain: cause attribution — `cause=MERCHANT` means the ladder is **not** applied
- Atomic emission of the five events in one transaction
- Full refund; `ALTERNATIVES_OFFERED` computed by calendar query
- Integration test: confirm → decline → assert refund issued, slot released, customer cost ₹0

**This is the milestone that matters.** If everything after this slice fell over, there would still be
a submission that makes its case.

---

## Slice 4 — Authorisations and the no-show charge · ~days 5–6

**The highest-risk slice, which is why it is scheduled while there is still room to react.**

- card manual-capture authorisation registration: customer → order with `token` block → auth payment
- Resolve the open question from dev-log 001: **is the auth transaction ₹1, or can it be the deposit?**
  (decides one payment or two at booking)
- `AUTHORIZATION_HELD` with the real ceiling, `enforced_by: payment_rail`
- `charge_no_show`, gated on elapsed time **and** merchant marking
- `AUTHORIZATION_RELEASED` wired into the decline path
- **Prove the ceiling:** attempt a capture above the authorised amount, assert Razorpay refuses it,
  assert `ACTION_REFUSED` lands in the trail naming `payment_rail` as the enforcer

That last item is not a test — it is a **demo asset**. It is how B3 gets *shown* rather than asserted.

---

## Slice 5 — Cancel and reschedule · ~days 6–7

- `cancel` with server-clock tier computation, retention and refund split
- `reschedule` as a self-transition — same booking id, same deposit, same authorisation
- Ladder gate on reschedule (no dodging a 100% tier by moving out then cancelling)
- Background worker: hold expiry, no-show eligibility, via `FOR UPDATE SKIP LOCKED`

---

## Slice 6 — The live audit trail viewer · ~days 7–8

- SSE endpoint streaming events as they are appended
- React + Vite + Tailwind; live list, expandable to the four fields
- Visual weight on `bound.enforced_by` — `payment_rail` must *look* different from `latch_policy`
- Running totals: customer cost, merchant retention, authorisation headroom

**This is a product surface, not a debug page.** It is one of two things a judge looks at.

---

## Slice 7 — Deploy and connect a remote agent · ~day 8

- Switch MCP to Streamable HTTP
- Deploy to Railway with managed Postgres
- Connect a **remote** agent to the **deployed** endpoint

**Do not leave this to the end.** A demo that only runs locally undercuts the entire claim that any
third-party agent can reach a merchant without a partnership.

---

## Slice 8 — Hardening · ~day 9

- Concurrency test: parallel `hold_slot` on one slot, assert exactly one winner
- Race test: hold expiry vs. confirm under lock
- Idempotency test: duplicate money calls under concurrent retry
- Every refusal code exercised
- Seed script: clinic, Dr. Rao, services, policy v4 — one command to a demo-ready state

---

## Slice 9 — Submission · ~day 10

- 5-minute video
- Final dev log; pick the failure-and-recovery story (candidates tracked in dev-log 002)
- **Re-verify Razorpay changelog and UCP roadmap** — brief §7 requires this immediately before
  submitting, in case the gap closed
- Repo tidy, README final

---

## Video structure (5 minutes)

| Time | Beat |
|---|---|
| 0:00–0:30 | The problem. "Book me a dermatologist Thursday." It can find one, it can't book one |
| 0:30–1:00 | Why: every protocol assumes a SKU. UCP has Shopping, Lodging, Food. No appointments primitive exists |
| 1:00–2:00 | Live: a real agent holds a slot, reads the ladder, pays a deposit. Trail streaming beside it |
| 2:00–2:45 | **The bound.** Attempt an over-ceiling capture against the session-complete mandate. Razorpay refuses it. Show the refusal in the trail. *"This isn't caught. It's impossible."* |
| 2:45–3:45 | **The failure.** Doctor calls in sick. Decline → refund → authorisation released → alternatives offered. Customer cost ₹0, no human |
| 3:45–4:30 | Architecture: audit trail as source of truth; four mandatory fields; bound outside our trust boundary |
| 4:30–5:00 | The money. ₹3 lakh/month evaporating per clinic; deposit forfeiture recovers it automatically, the way Indian merchants actually run this |

**The 2:00–2:45 beat is the differentiator.** Most submissions will *claim* bounds. Showing Razorpay
refuse a debit our own server requested is the moment the architecture becomes visible.

---

## What gets cut, in order

Cut from the top if the timeline compresses. Detail in `04-features-and-limitations.md` §3.

1. Policy editor UI → seed in SQL
2. Reschedule price delta → same-price moves only
3. Viewer polish → flat live list
4. `find_slots` filters → next-available only
5. Multi-practitioner → one practitioner

**Never cut:** the event store and four-field money event · authorisation hold with a real ceiling ·
the merchant-decline path · ladder boundary tests on a frozen clock · the concurrency test.
