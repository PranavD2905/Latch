# Slice 2 — Real Razorpay, deposit leg

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Latch exposes an Indian dermatology clinic to any third-party AI agent over MCP, with appointment
money semantics as the product. Razorpay AI Buildathon 2026, Track 01.

**Slices 0–1 are complete**: event store, ladder evaluator, four MCP tools, `FakePaymentProvider`, MCP
over stdio. A booking can be made end to end with fake money.

This slice replaces the fake provider with real Razorpay **test mode** for the deposit leg only.

## Read before writing any code

- `dev-logs/001-2026-08-23-payment-primitive-research.md` — **read this first.** It records why the
  brief's original plan (UPI Reserve Pay) was abandoned and what replaced it. Do not re-litigate.
- `docs/02-tech-stack.md` §13 (payments), `docs/01-architecture.md` §6 (idempotency)
- `docs/05-cost-model.md` §2 — the fee structure, including that refunds do **not** return the fee
- **The most recent `dev-logs/` entry**

## Settled decisions — do not re-open these

- Razorpay Node SDK, test mode. Mandated by the competition and correct anyway.
- **Wrapped behind the `PaymentProvider` port.** The domain must never import the Razorpay SDK. If you
  find yourself importing it outside `src/adapters/`, stop — the architecture has been violated.
- `FakePaymentProvider` stays. It is not scaffolding to delete; it is how the domain is tested fast and
  how failure modes that a sandbox will not reliably produce get proven.
- Amounts are in paise everywhere, which matches Razorpay's own convention.

## Build this

**1. `RazorpayPaymentProvider`** implementing the existing port. Same interface as the fake — if the
interface needs to change to accommodate reality, change it in the port and update both
implementations, then say so in the dev log.

**2. Deposit capture**
- Orders API: create an order for the deposit amount
- Capture the payment
- `DEPOSIT_CAPTURED` must carry the **real** `razorpay_payment_id` in its `authority` field. That is
  the point of the field — the trail cites external evidence, not our own claim.

**3. Refunds** — build the call now even though the failure path lands in Slice 3. It is the same
adapter and Slice 3 should not have to touch payment code.

**4. Idempotency mapping.** Our idempotency keys must map onto Razorpay's own idempotency mechanism.
An agent retrying `confirm_with_deposit` after a timeout must not produce two captures. Test this
explicitly — fire the same key twice and assert one payment exists at Razorpay, not two.

**5. Error mapping.** Razorpay errors become our refusal codes from `docs/03-domain-model.md` §5.
Never leak a raw SDK error to an agent — agents need stable machine-readable codes.

## Test mode specifics

- Test UPI IDs: `success@razorpay` and `failure@razorpay`
- Test mode uses separate API keys from live. Put them in `.env`, never commit them.
- Check `docs/05-cost-model.md` — no real money moves, so this slice costs ₹0

## Watch for

Razorpay's capture behaviour is configurable (automatic vs manual) both globally on the dashboard and
per-order via the Orders API. Deposits should capture immediately — we are not holding money at this
step, we are taking it. If you find the account defaulting to manual capture, set it explicitly per
order rather than relying on a dashboard setting a fresh clone will not have.

**Do not use manual capture as a "hold" mechanism.** Dev-log 001 records why: Razorpay auto-refunds
uncaptured authorisations within ~3 days, and appointments are booked weeks out. This was investigated
and rejected.

## Done when

- A deposit appears in the Razorpay **test dashboard** after an agent completes a booking
- `DEPOSIT_CAPTURED` in the event log carries the real `payment_id`
- Integration test: full booking flow against test mode, asserting the event trail
- Idempotency test: same key twice produces one capture
- Refund call works (even though nothing calls it in a flow yet) — assert against test mode
- Domain tests still pass unchanged against `FakePaymentProvider`, and still run in milliseconds

## Out of scope — do not build

Authorisations (Slice 4), the merchant decline flow (Slice 3), `cancel`, `reschedule`, `charge_no_show`.

## Before you finish

Write the next `dev-logs/` entry. Record anything where test-mode behaviour differed from the docs —
that is exactly the kind of thing later slices need to know, and it may become the submission's
failure-and-recovery story (candidates are tracked in `dev-logs/002`).
