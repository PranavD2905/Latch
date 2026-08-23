# Dev Log 005 — Payment rail correction: manual capture replaces the mandate

**Date:** 23 August 2026
**Phase:** Pre-Slice-2 (Slices 0–1 complete)
**Status:** Decided — supersedes the rail choice in dev-log 001

---

## What changed and why

Direction received: **UPI Reserve Pay is not usable for this build.** Reasons given, all of which check
out and go further than dev-log 001 did:

- Reserve Pay is **activation-gated** — a support request plus an eligible business category
- **No documented test-mode flow**
- Test-mode UPI is mocked to the point that **cancellation returns success regardless**, which silently
  breaks any release-the-authority path

That third point matters more than it first appears. Dev-log 001 chose **UPI Autopay mandates** as the
replacement for Reserve Pay, and mandate *revocation* would have hit exactly the same mocked-cancel
problem. A test-mode revoke that always returns success cannot prove the merchant-decline path leaves
no orphaned authority — which is the single thing that path exists to demonstrate.

So the mandate route was compromised for the same underlying reason, and dev-log 001's conclusion is
superseded here.

**New rail: card manual capture** (`capture: "manual"`) as the **test-mode stand-in**, with Reserve Pay
documented as the **production rail**.

---

## Verification against Razorpay's current Orders/Payments API

The direction included an instruction to verify manual-capture behaviour, *"authorisation validity
windows in particular."* Verified. Three hard constraints, two of which block the proposed mechanism as
literally written.

### Constraint 1 — capture must equal the authorised amount ⛔ blocking

Razorpay's Capture API returns the error **"Capture amount must be equal to the amount authorized."**

There is **no partial capture and no multi-capture** against a single authorisation. The proposed flow —

> `confirm_with_deposit` captures the policy deposit, then `charge_no_show` captures against the
> *remaining authorised amount*

— cannot be built. After a capture there is no remaining authorised amount; the authorisation is
consumed in full by its one and only capture.

### Constraint 2 — there is no void endpoint ⛔ blocking

No void/cancel-authorisation API is documented anywhere in the Payments API. "Voided" appears only in
error strings describing a state a payment may already be in. The proposed

> merchant-decline path — **void the authorisation**

is not an available operation.

### Constraint 3 — authorisations live at most 5 days ⚠️ limiting

From the capture-settings API docs: `manual_expiry_period` **defaults to 7200 minutes (120 hours = 5
days)** and **7200 is also the maximum.** Payments still in `authorized` after it are auto-refunded.

Five days is a hard ceiling, not a default that can be raised. An appointment booked two weeks out
cannot carry a card authorisation from booking to appointment. This is the constraint dev-log 001
originally rejected card manual capture over; it is real, and it is now accepted as a scoped limitation
rather than a reason to reject the rail.

---

## The adapted design

The direction's *intent* is preserved in full — manual capture as the test-mode rail, confined to one
module, named in the trail. Only the mechanism changes, because the proposed one is not available.

**Two payment objects at `confirm_with_deposit`, not one:**

| Object | Mode | Amount | Purpose |
|---|---|---|---|
| Deposit | captured immediately | policy deposit (₹300) | Money actually taken |
| No-show authorisation | `capture: "manual"`, `manual_expiry_period` at max | **exactly** the no-show fee (₹400) | The bounded, unexercised authority |

Mapped onto the tool surface:

| Tool | Under the manual-capture rail |
|---|---|
| `hold_slot` | No payment object. TTL'd reservation only. **Unchanged** |
| `confirm_with_deposit` | Capture the deposit; separately authorise the no-show fee, leave it `authorized` |
| `charge_no_show` | Capture that authorisation **in full** — it was authorised at exactly the fee |
| `cancel` / merchant-decline | Refund captured deposit per cause; **release the authorisation by lapse** |

### Why "release by lapse" rather than void

With no void endpoint, releasing an unexercised authorisation has two options:

1. **Capture then refund** — instant, but briefly debits a customer who owes nothing, and burns ~₹9.44
   of unrecoverable MDR (`docs/05-cost-model.md`: fees are not returned on refund). Rejected.
2. **Let it lapse** — we stop tracking it and record `AUTHORIZATION_RELEASED`; Razorpay auto-refunds at
   `manual_expiry_period`. The customer is **never debited**. Chosen.

Net customer cost stays **₹0**, which is the property the failure path must preserve. The honest
difference from the brief's `REVOKE mandate` line is that release is now **asynchronous** — the
authority stops being exercisable immediately (we will never capture it) but formally clears at expiry.
The trail must say so rather than implying an instant revoke.

### The bound survives, in better shape

This was the strongest architectural claim in the project and I was concerned the rail swap would
weaken it. It does not.

| | Old (mandate) | New (manual capture) |
|---|---|---|
| Ceiling | `max_amount` on the mandate | The **authorised amount itself** |
| Headroom to abuse | ₹1,500 ceiling vs ₹400 fee = ₹1,100 of slack | **Zero** — authorised at exactly the fee |
| Enforced by | Razorpay | Razorpay |
| Over-charge attempt | Rejected as exceeding ceiling | Rejected: capture ≠ authorised amount |

The new bound is **tighter**. Under the mandate there was ₹1,100 of headroom a compromised server could
have drawn against. Under manual capture there is none — the only capture the rail will accept is
exactly the amount authorised at booking, in front of the customer, under a stated policy version.

B3's *"impossible, not merely caught"* holds. The over-ceiling refusal demo (Slice 4, the 2:00–2:45
video beat) still works: request a capture above the authorised amount, and Razorpay refuses it.

---

## Consequential changes

**Rail named in the trail (B5).** Every money event gains a `rail` field:
`manual_capture` (active) | `reserve_pay` (production, not built). The trail must not imply the
production rail was exercised.

**`bound.enforced_by` generalised.** `razorpay_mandate` → `payment_rail`, since the enforcing rail now
swaps. Values: `latch_policy` < `db_constraint` < `payment_rail`.

**Event renames.** `MANDATE_REGISTERED` → `AUTHORIZATION_HELD`; `MANDATE_REVOKED` →
`AUTHORIZATION_RELEASED`. New: `AUTHORIZATION_LAPSED`.

**New refusal codes.** `AUTHORIZATION_EXPIRED`, `CAPTURE_AMOUNT_MISMATCH`.

**New background job — authorisation expiry.** Because the authority now has a 5-day life, the system
must know when it has *lost* it rather than discovering that at charge time. A worker emits
`AUTHORIZATION_LAPSED` when an authorisation passes `manual_expiry_period`, and `charge_no_show`
refuses with `AUTHORIZATION_EXPIRED` thereafter.

This is not damage control — it is the audit trail earning its keep. The system records losing its own
authority, so a merchant reading the trail learns why a no-show was uncollectable instead of finding a
silent failure.

**Single-module confinement.** A `PaymentRail` port with `ManualCaptureRail` (built) and
`ReservePayRail` (documented, not built). No `capture` / `payment_capture` semantics may appear in
`src/app/` or `src/domain/`. Slices 0–1 already put `PaymentProvider` behind a port, so this is a
rename and a widening, not a rewrite.

---

## Scoped limitation, stated openly

**Appointments must be within ~5 days of booking for a no-show authorisation to exist.**

- The demo books inside that window — the brief's own scenario (book Tuesday, appointment Thursday,
  decline Wednesday) fits comfortably
- Beyond 5 days, no-show authority cannot be held on this rail. **This is precisely why Reserve Pay is
  the production rail**, and it is the honest version of the argument rather than a weakness to hide
- `agentic-services-transactability-brief.md` §7 explicitly directs stating such constraints in the
  pitch rather than letting a judge discover them

---

## What did not change

Everything in brief §6.5 holds, as the direction stated:

- Bounds still server-side **and** rail-enforced
- Gates still preconditions — `charge_no_show` still needs elapsed time **and** merchant marking
- Ladder still computed from the server clock
- Holds still move no money
- Event sourcing, the four mandatory fields, the partial unique index: untouched

---

## Sources

- https://razorpay.com/docs/api/payments/capture/ — "Capture amount must be equal to the amount authorized"
- https://razorpay.com/docs/payments/payment-gateway/rainy-day/capture-settings/api/ — `manual_expiry_period`, default and max 7200 minutes
- https://razorpay.com/docs/payments/payments/capture-settings/ — auto-refund of uncaptured authorisations
- https://razorpay.com/docs/api/refunds/ — refunds require captured state
