# Slice 4 — Mandates and the no-show charge ⭐ (highest risk)

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Latch exposes an Indian dermatology clinic to any third-party AI agent over MCP. Razorpay AI
Buildathon 2026, Track 01.

**Slices 0–3 are complete**: event store, ladder, MCP tools, real Razorpay deposits, and the full
merchant-decline failure path.

## Why this slice is scheduled here

This is the **highest-uncertainty work in the project**, and it is scheduled early enough that
discovering a problem still leaves time to respond. Two questions were left unresolved during design
and you are the session that resolves them. If test mode behaves differently from the documentation,
that is important information — record it, adapt, and update the docs.

## Read before writing any code

- `dev-logs/001-2026-08-23-payment-primitive-research.md` — **read this in full first.** It records
  why UPI Reserve Pay and card manual-capture were both rejected, and why UPI Autopay mandates won.
  Do not re-litigate any of it.
- `docs/01-architecture.md` §1 Idea 3 (bounds outside the trust boundary), §3, §9 (trust model)
- `docs/03-domain-model.md` §3 Rule 3, §4 (the `bound.enforced_by` enum), §5
- `docs/05-cost-model.md` §5 — mandate pricing is unknown; flag anything you learn

## The claim this slice makes real

Every other Track 01 submission will *claim* its money actions are bounded. Most will implement that
claim as a server-side `if` statement.

> The no-show ceiling is `max_amount` on a **UPI Autopay mandate**. Razorpay enforces it, not us. Even
> a fully compromised Latch server cannot debit ₹50,000 against a mandate registered at ₹1,500.

The bar (**B3**) demands bounds be *"impossible, not merely caught."* A server-side check is caught. A
mandate ceiling is impossible. **This slice is where that becomes true rather than aspirational.**

## Build this

**1. Mandate registration** — three steps, per Razorpay's S2S recurring-payments docs:

```
POST /v1/customers                        → customer_id
POST /v1/orders  (with a token block)     → order_id
create authorisation payment              → payment_id + token_id
```

The token block on the order carries the fields that matter:
```
token: {
  max_amount:  <no_show ceiling in paise>,   // THE BOUND
  expire_at:   <unix ts>,                    // the mandate's own TTL
  frequency:   "as_presented"
}
```

**2. Resolve the open question from dev-log 001**

*Must the authorisation transaction be ₹1, or can it be the deposit amount itself?*

This decides whether booking is **one payment or two** — and therefore one Razorpay fee or two (see
`docs/05-cost-model.md`). Find out empirically against test mode. Whatever you learn, write it into
the dev log and update `docs/03-domain-model.md` and `docs/05-cost-model.md` to match.

**3. `MANDATE_REGISTERED` event**
Carries the real `token_id`, the real ceiling, and — critically —
`bound.enforced_by: 'razorpay_mandate'`. Not `'latch_policy'`. The distinction is the whole point and
the viewer will render it differently in Slice 6.

**4. `charge_no_show`** — the most dangerous action in the system, so it has the strongest gate.

Requires **two independent facts, from two different authorities**:
- appointment start + grace period has elapsed (the **server** owns this — never an agent's claim)
- the merchant has explicitly marked non-attendance (**no agent can forge this**)

Time alone never moves money. `NO_SHOW_ELIGIBLE` ≠ `NO_SHOW_CHARGED` — see
`docs/03-domain-model.md` §3 Rule 3. A money action firing on elapsed time alone would be firing on
inference, which bar clause **B4** forbids.

**5. Real `MANDATE_REVOKED`** — replace the stub left in Slice 3. The decline path must leave **no
orphaned authority**. Assert the token is genuinely cancelled at Razorpay, not merely marked revoked
in our log.

**6. ⭐ Prove the ceiling — this is a demo asset, not just a test**

Deliberately attempt a debit **above** `max_amount`. Assert:
- Razorpay refuses it
- we map that to `MANDATE_CEILING_EXCEEDED`
- an `ACTION_REFUSED` event lands in the trail, recording that the refusal came from
  `razorpay_mandate`, not from us

**This is the 2:00–2:45 beat of the pitch video** (`docs/06-build-sequence.md`). It is the moment the
architecture becomes visible to a judge — our own server asking for money and being told no by the
rail. Make it clean and make it easy to trigger on demand; a seed script or a flag is fine.

## Done when

- A mandate is registered against Razorpay test mode with a real ceiling
- `charge_no_show` succeeds within the ceiling, and the debit is visible in the test dashboard
- An over-ceiling charge is **refused by Razorpay** and the refusal is in the event log
- Charging before start + grace is refused with `NOT_YET_ELIGIBLE`
- Charging without merchant marking is refused with `MERCHANT_ACTION_REQUIRED`
- Declining a confirmed booking genuinely revokes the mandate at Razorpay
- The ₹1-vs-deposit question is answered, documented, and reflected in the code

## If test mode blocks you

UPI Autopay may behave unexpectedly in test mode. If you hit a wall:
1. Record exactly what failed in the dev log — **this may be the submission's failure-and-recovery
   story**, which is a required deliverable (candidates tracked in `dev-logs/002`)
2. Do not silently fall back to a fake. If the real mandate cannot be registered, make that visible
   and state the constraint openly — `agentic-services-transactability-brief.md` §7 explicitly says to
   state such constraints in the pitch rather than let a judge discover them
3. `FakePaymentProvider` can still prove the *logic*, but say clearly which parts are real

## Out of scope

`reschedule`, customer `cancel` with ladder, background workers, the viewer, deployment.

## Before you finish

Write the next `dev-logs/` entry. Update `docs/05-cost-model.md` §5 with any pricing you learn.
