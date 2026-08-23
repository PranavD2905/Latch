# Slice 4 — The no-show authorisation and charge ⭐ (highest risk)

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Latch exposes an Indian dermatology clinic to any third-party AI agent over MCP. Razorpay AI
Buildathon 2026, Track 01.

**Slices 0–3 are complete**: event store, ladder, MCP tools, real Razorpay deposits, and the full
merchant-decline failure path.

## ⚠️ Read dev-log 005 before anything else

`dev-logs/005-2026-08-23-payment-rail-correction.md` **supersedes the rail choice in dev-log 001.**

The short version: UPI Reserve Pay is activation-gated with no test-mode flow, and test-mode UPI
returns success on cancellation regardless — which would silently break the release path. UPI Autopay
mandates hit the same mocked-cancel problem. **The rail is now card manual capture**, with Reserve Pay
documented as the production rail.

Three verified Razorpay constraints shape this slice. Do not design around them without re-verifying:

1. **Capture must equal the authorised amount.** No partial capture, no multi-capture. One
   authorisation is consumed by exactly one capture.
2. **There is no void endpoint.** Releasing an authorisation means never capturing it and letting it
   lapse.
3. **`manual_expiry_period` maxes at 7200 minutes (5 days).** Uncaptured authorisations auto-refund.

## Also read

- `docs/01-architecture.md` §1 Idea 3 (bounds outside the trust boundary), §8, §9
- `docs/03-domain-model.md` §3 Rule 3, §4 (the four fields + `rail`), §5 (refusal codes)
- `docs/04-features-and-limitations.md` §2.2 — the limitations this slice creates
- **The most recent `dev-logs/` entry**

## The claim this slice makes real

Every other Track 01 submission will *claim* its money actions are bounded. Most will implement that
claim as a server-side `if`.

> The no-show charge is a card authorisation placed at booking for **exactly** the no-show fee.
> Razorpay's Capture API refuses any capture that is not equal to the amount authorised. There is no
> headroom — not because we check, but because the rail will not accept anything else.

The bar (**B3**) demands bounds be *"impossible, not merely caught."* A server-side check is caught.
This is impossible. **This slice is where that becomes true rather than aspirational.**

## Build this

**1. `PaymentRail` port with two implementations**

- `ManualCaptureRail` — built, active
- `ReservePayRail` — a documented stub that throws. It exists to prove the swap is a module boundary,
  not a rewrite.

**No `capture` / `payment_capture` semantics may appear in `src/app/` or `src/domain/`.** If you find
yourself writing `capture: "manual"` outside `src/adapters/payment/`, the confinement has been
violated.

**2. Two payment objects at `confirm_with_deposit`**

| Object | Mode | Amount |
|---|---|---|
| Deposit | captured immediately | policy deposit (₹300) |
| No-show authorisation | `capture: "manual"`, `manual_expiry_period` at max | **exactly** the no-show fee (₹400) |

Authorising at exactly the fee is the whole point — it leaves zero headroom. Do not authorise a larger
"ceiling with room to spare."

**3. `AUTHORIZATION_HELD` event**
Carries the real payment id, the authorised amount, the lapse time, `bound.enforced_by: 'payment_rail'`,
and `rail: 'manual_capture'`.

**The `rail` field is required on every money event.** The trail is a judged deliverable under B5 and
must never imply the production rail was exercised when it was not.

**4. `charge_no_show`** — captures the authorisation in full.

Gate requires **two independent facts, from two different authorities**:
- appointment start + grace elapsed (the **server** owns this — never an agent's claim)
- merchant explicitly marked non-attendance (**no agent can forge this**)

Time alone never moves money (`docs/03-domain-model.md` §3 Rule 3).

**5. Release by lapse** — replace the Slice 3 stub.

With no void endpoint, releasing means: stop tracking, append `AUTHORIZATION_RELEASED`, never capture.
Razorpay auto-refunds at expiry. **Do not capture-then-refund to release** — it briefly debits a
customer who owes nothing and burns ~₹9.44 of unrecoverable MDR.

Net customer cost stays ₹0. But release is **asynchronous**, and the trail must say so rather than
implying an instant revoke.

**6. Authorisation-lapse worker + `AUTHORIZATION_EXPIRED` refusal**

Because the authority now has a 5-day life, the system must know when it has *lost* it rather than
discovering that at charge time. Emit `AUTHORIZATION_LAPSED` when an authorisation passes its expiry;
`charge_no_show` refuses with `AUTHORIZATION_EXPIRED` thereafter.

This is the audit trail earning its keep — a merchant reads *why* a no-show was uncollectable instead
of finding a silent failure.

**7. ⭐ Prove the ceiling — a demo asset, not just a test**

Deliberately request a capture **above** the authorised amount. Assert:
- Razorpay refuses it (*"Capture amount must be equal to the amount authorized"*)
- we map it to `CAPTURE_AMOUNT_MISMATCH`
- an `ACTION_REFUSED` event lands naming `payment_rail` as the enforcer

**This is the 2:00–2:45 beat of the pitch video.** Make it trivially easy to trigger on demand — a seed
flag or script. Fumbling it live wastes the strongest moment in the pitch.

## Done when

- A no-show authorisation exists at Razorpay test mode in `authorized` state, at exactly the fee
- `charge_no_show` captures it; the capture is visible in the test dashboard
- An over-amount capture is **refused by Razorpay** and the refusal is in the trail
- Charging before start + grace → `NOT_YET_ELIGIBLE`
- Charging without merchant marking → `MERCHANT_ACTION_REQUIRED`
- Charging after lapse → `AUTHORIZATION_EXPIRED`, with `AUTHORIZATION_LAPSED` already in the trail
- Merchant decline leaves the authorisation uncaptured; customer is never debited
- Every money event carries `rail`
- `ReservePayRail` exists as a stub and the swap is a one-line construction change

## Scoped limitation to respect

**Appointments must be within ~5 days for a no-show authorisation to exist.** Seed and demo inside that
window — the brief's own scenario (book Tuesday, appointment Thursday, decline Wednesday) fits. Do not
paper over this; it is *why* Reserve Pay is the production rail, and stating it openly is what
`agentic-services-transactability-brief.md` §7 directs.

## Before you finish

Write the next `dev-logs/` entry. If test-mode manual capture diverges from the documented behaviour,
that is a **strong failure-and-recovery story candidate** — record it precisely.
