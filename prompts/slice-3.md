# Slice 3 — The failure path ⭐

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Latch exposes an Indian dermatology clinic to any third-party AI agent over MCP, with appointment
money semantics as the product. Razorpay AI Buildathon 2026, Track 01.

**Slices 0–2 are complete**: event store, ladder, four MCP tools, real Razorpay test-mode deposits.

## This slice is the most important one in the project

Razorpay's bar (clause **B5**) asks for *"the audit trail and one failure handled gracefully."* This
slice is that failure. **If everything after this slice fell over, there would still be a submission
that makes its case.** Build it properly.

## Read before writing any code

- `docs/01-architecture.md` §7 — the failure path, end to end, with the diagram
- `docs/03-domain-model.md` §3 (Rule 2: cause is an input, never an inference) and §6 (worked trace)
- `docs/05-cost-model.md` §2 — why a graceful failure still costs the merchant ₹7.08
- `agentic-services-transactability-brief.md` §6.4 — the original scenario
- **The most recent `dev-logs/` entry**

## The scenario

An agent books a 4pm Thursday dermatology consult. ₹300 deposit captured. On Wednesday the
practitioner calls in sick and **the merchant declines an already-confirmed, already-paid slot.**

Goods commerce has no flow for this at all — there is no "seller rejects a paid order" event type in
UCP or ACP. That is why this failure was chosen over a staged network error: it is a failure of the
*domain*, not of the implementation, so handling it is a feature we had to build regardless.

## Build this

**1. Merchant API: `decline_booking`**
Authenticated with the merchant token. Takes a `booking_id` and a `reason`. This is a merchant action —
**no agent can invoke it.**

**2. Cause attribution — the part that must be exactly right**

`cancel` takes `cause` as a **required** field: `CUSTOMER` or `MERCHANT`. The system never infers it.

- `cause=CUSTOMER` → the cancellation ladder applies
- `cause=MERCHANT` → **the ladder does not apply.** Full refund. No retention.

Getting this backwards means charging a patient a penalty because their doctor fell ill. That is the
single most damaging bug this system could ship. Make omission impossible at the type level, and write
a test that asserts a merchant-caused cancellation retains exactly ₹0 regardless of how close to the
appointment it happens — including inside the 100% tier, where a customer cancellation would retain
everything.

**3. Five events, atomically, in one database transaction**

All five or none. A partial unwind — refund issued but mandate not revoked, or slot released but no
refund — is worse than a clean failure.

```
MERCHANT_DECLINED     reason, cause=MERCHANT, authority = merchant action
SLOT_RELEASED         returns to inventory, freeing the partial unique index
REFUND_ISSUED         full deposit → original instrument, real razorpay refund_id
MANDATE_REVOKED       stub this slice — real revocation lands in Slice 4
ALTERNATIVES_OFFERED  3 slots, same service, comparable practitioner
```

**4. `ALTERNATIVES_OFFERED` is a calendar query, not an LLM call.**

It reuses `find_slots` with the original booking's constraints. Do not reach for a model here. A model
in the recovery path of a money failure would add non-determinism, latency, and per-event cost to the
exact place that most needs to be predictable. This is stated in `docs/05-cost-model.md` §1 and it is
a deliberate architectural position, not an optimisation.

**5. Push the offer back to the originating agent** in structured form.

## Done when

- Integration test against Razorpay test mode: `hold → confirm → decline` and assert:
  - deposit was refunded **in full** (verify the refund exists at Razorpay, not just in our log)
  - the slot is bookable again
  - net customer cost is **₹0**
  - all five events exist, in order, in one transaction
  - `MERCHANT_DECLINED` records `cause=MERCHANT` and the ladder was not applied
- A test that declines a booking **2 hours before** the appointment (deep inside the 100% retention
  tier) and asserts ₹0 retained — proving cause attribution beats proximity
- A test that a partial failure mid-sequence rolls back **all five** events
- No agent-callable path can trigger a decline

## Out of scope — do not build

Real mandate revocation (Slice 4 — stub the event for now), `charge_no_show`, `reschedule`, customer
`cancel` with ladder applied (Slice 5), the viewer.

## Before you finish

Write the next `dev-logs/` entry. This slice's trace is what the video shows — if the real event log
differs in any way from the worked trace in `docs/03-domain-model.md` §6, **update that doc to match
reality.** The demo script is built from it.
