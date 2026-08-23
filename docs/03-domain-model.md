# Latch — Domain Model

**Status:** Decided
**Date:** 23 August 2026

This is the document you build from. `01-architecture.md` says *how the system is shaped*; this says
*what the system actually knows and what it is allowed to do.*

---

## 1. Entities

Six, and no more. Every one of them exists because a money decision depends on it.

| Entity | What it is | Why it must exist |
|---|---|---|
| `Merchant` | The clinic. One per deployment. | Owns the Razorpay account and the policy |
| `Practitioner` | Dr. Rao. Has working hours. | Slots are per-practitioner; a booking is against a person, not a business |
| `Service` | "Dermatology consult, 30 min, ₹800" | Carries duration and price — both inputs to money |
| `Policy` | Deposit rule + cancellation ladder + no-show terms. **Versioned.** | The authority every money action cites (B2) |
| `Booking` | The aggregate. Its state is a fold over its events. | The thing money attaches to |
| `Event` | One immutable fact. Append-only. | **The source of truth.** Everything above is derived |

**There is no `Slot` table.** Slots are *computed* — a practitioner's working hours, minus a service's
duration, minus existing live bookings. This is brief §2.3 property #2 ("computed, not stocked,
availability") taken seriously. Storing slots would mean generating rows for every possible future
time, then keeping them in sync with working-hour changes. Computing them means availability is always
correct by construction.

The `bookings` table carries `(practitioner_id, starts_at)` and the partial unique index on those
columns is what makes a computed slot exclusive. That index *is* the slot table, in effect — it just
only has rows for slots someone actually wanted.

---

## 2. Policy — the authority

```jsonc
{
  "policy_version": 4,                    // bumped on every change; events cite the version
  "deposit": {
    "type": "fixed",
    "amount_paise": 30000                 // ₹300
  },
  "cancellation_ladder": [                // ordered, descending by hours_before
    { "hours_before": 48, "retain_pct": 0   },
    { "hours_before": 12, "retain_pct": 50  },
    { "hours_before": 0,  "retain_pct": 100 }
  ],
  "no_show": {
    "fee_paise": 40000,                   // ₹400
    "grace_minutes": 15,
    "mandate_ceiling_paise": 150000       // ₹1,500 — registered on the mandate itself
  },
  "hold_ttl_seconds": 600,                // 10 minutes
  "max_concurrent_holds_per_agent": 3
}
```

**Why versioned.** A booking made under ladder v4 must be cancelled under ladder v4, even if the
merchant has since published v5. Money rules cannot change retroactively on a customer who already
committed. Every event carries the `policy_version` it acted under, so the trail explains itself years
later without needing to know what the policy is *today*.

This single field is most of bar clause **B2**. "Why was ₹400 retained?" is answered by "ladder v4,
tier `hours_before: 12`, `retain_pct: 50`, on a ₹800 service" — a complete causal account, with no
database lookup required.

### The ladder evaluator

The only genuinely subtle piece of logic in the system, so it is specified exactly.

```
evaluateLadder(ladder, appointmentStart, now) → { tier, retain_pct }

  hoursUntil = (appointmentStart - now) / 3_600_000        // now comes from the Clock port

  return the FIRST tier (descending hours_before) where hoursUntil >= tier.hours_before
```

Worked examples against the ladder above:

| `hoursUntil` | Tier matched | Retained | Refunded (of ₹300 deposit) |
|---|---|---|---|
| 72.0 | `hours_before: 48` | 0% | ₹300 |
| 48.0 | `hours_before: 48` | 0% | ₹300 |
| 47.99 | `hours_before: 12` | 50% | ₹150 |
| 12.0 | `hours_before: 12` | 50% | ₹150 |
| 11.99 | `hours_before: 0` | 100% | ₹0 |
| −2.0 (already started) | `hours_before: 0` | 100% | ₹0 |

**Boundaries are inclusive on the upper side** — at exactly 48 hours the customer gets the *better*
tier. This is a deliberate choice: ambiguity in a penalty schedule should resolve in favour of the
person being penalised. It is also the exact behaviour the tests pin, using a frozen clock.

**Rounding.** `retain = floor(deposit * pct / 100)`, refund is the remainder. Integer paise
throughout, floor rather than round, so rounding error can never manufacture money — the two halves
always sum to exactly the deposit.

---

## 3. Booking state machine

```
                         ┌──────────┐
              hold_slot  │          │  TTL elapses
         ─────────────▶  │   HELD   │ ──────────────▶  EXPIRED  (terminal)
                         │          │
                         └────┬─────┘  release_hold
                              │        ──────────────▶  RELEASED (terminal)
       confirm_with_deposit   │
       ┌──────────────────────┘
       │  · deposit captured
       │  · mandate registered
       ▼
  ┌───────────┐   reschedule (money preserved, slot moves)
  │           │ ◀──────────────┐
  │ CONFIRMED │ ───────────────┘
  │           │
  └─────┬─────┘
        │
        ├── cancel(cause=CUSTOMER) ──▶ ladder applies ──▶ CANCELLED_BY_CUSTOMER (terminal)
        │
        ├── cancel(cause=MERCHANT) ──▶ ladder does NOT ──▶ DECLINED_BY_MERCHANT  (terminal)
        │                              apply; full refund;      ★ the B5 failure path
        │                              mandate revoked;
        │                              alternatives offered
        │
        ├── start time + grace elapses ──▶ NO_SHOW_ELIGIBLE
        │                                        │
        │                                        │ merchant marks non-attendance
        │                                        ▼
        │                                  charge_no_show
        │                                        │
        │                                        ▼
        │                                  NO_SHOW_CHARGED (terminal)
        │
        └── merchant marks attended ──▶ COMPLETED (terminal)
```

### The three rules this diagram encodes

**Rule 1 — `HELD` carries no money.** Nothing in or out of that state involves a payment object. An
agent can hold and abandon freely; the cost is ₹0 (see `05-cost-model.md` for why this matters
financially as well as architecturally).

**Rule 2 — cause is an input, never an inference.** `cancel` takes `cause` as a *required* field. The
system never guesses whether a cancellation was the customer's fault or the merchant's. Getting this
wrong means charging a patient a penalty because their doctor fell ill — the single most damaging bug
this system could ship — so it is made structurally impossible to omit rather than defaulted.

**Rule 3 — `NO_SHOW_ELIGIBLE` is not `NO_SHOW_CHARGED`.** Time passing makes a charge *permissible*.
It never makes one *happen*. The transition between them requires an explicit merchant action that no
agent can forge. This is bar clause **B4** at its sharpest: the most dangerous money action in the
system requires two independent facts, from two different authorities.

### Reschedule deserves a note

Reschedule is a **self-transition**, not a cancel-and-rebook. `CONFIRMED → CONFIRMED`, same booking id,
same deposit, same mandate, new `starts_at`.

This is brief §2.3 property #6 taken literally: *"Not return, not refund — a move."* Implementing it as
cancel-then-rebook would refund the deposit (losing ₹7.08 in unrecoverable MDR — see cost model), void
the mandate, and re-run the whole gate sequence. It would also break the audit trail's narrative: the
history should read as one booking that moved, because that is what happened.

The gate is a conjunction: the target slot must be free **and** the ladder must permit a move at the
current time-to-appointment. A customer cannot dodge a 100% cancellation penalty by rescheduling into
next month and cancelling for free from there — the ladder is evaluated at the moment of the
reschedule request, against the *original* appointment time.

---

## 4. Event catalogue

The append-only log. Every row is immutable.

| Event | Money | Emitted when |
|---|---|---|
| `HOLD_CREATED` | — | `hold_slot` succeeds |
| `HOLD_EXPIRED` | — | Background worker, TTL elapsed |
| `HOLD_RELEASED` | — | Agent releases explicitly |
| `POLICY_ACKNOWLEDGED` | — | Agent confirms it has read ladder vN |
| `DEPOSIT_CAPTURED` | **in** | Razorpay capture succeeds |
| `MANDATE_REGISTERED` | — | UPI Autopay token created, ceiling recorded |
| `BOOKING_CONFIRMED` | — | Both of the above succeeded |
| `BOOKING_RESCHEDULED` | delta only | Move succeeded |
| `CANCELLED_BY_CUSTOMER` | — | Cancel with `cause=CUSTOMER` |
| `RETENTION_APPLIED` | **kept** | Ladder retained a portion |
| `REFUND_ISSUED` | **out** | Razorpay refund succeeds |
| `MERCHANT_DECLINED` | — | Merchant declines a confirmed booking ★ |
| `MANDATE_REVOKED` | — | Token cancelled, ceiling returned |
| `ALTERNATIVES_OFFERED` | — | Replacement slots computed and pushed |
| `NO_SHOW_ELIGIBLE` | — | Start + grace elapsed |
| `NO_SHOW_CHARGED` | **in** | Debit against mandate succeeded |
| `ACTION_REFUSED` | — | A gate or bound rejected a command ★★ |

★ the B5 failure path.
★★ **Refusals are events too.** When an agent tries to exceed a bound or skip a gate, that attempt is
recorded permanently. This is what lets the demo *show the bound working* rather than merely assert it
exists — a judge can watch an over-limit charge be refused and see the refusal land in the trail with
its reason.

### Every money event carries these four fields

This is Idea 2 from the architecture doc, made concrete. The type system refuses a money event without
them.

```jsonc
{
  "event_id": "evt_01J...",
  "booking_id": "bkg_01J...",
  "type": "NO_SHOW_CHARGED",
  "occurred_at": "2026-08-27T11:20:34+05:30",   // server clock, always

  "action": {                                    // B1 — which rupee moved
    "direction": "debit",
    "amount_paise": 40000,
    "instrument": "upi_mandate"
  },
  "gate": {                                      // B4 — what permitted it
    "cleared": ["start_time_elapsed", "merchant_marked_non_attendance"],
    "evidence": { "started_at": "...", "marked_by": "merchant", "marked_at": "..." }
  },
  "bound": {                                     // B3 — the ceiling, and who holds it
    "ceiling_paise": 150000,
    "enforced_by": "razorpay_mandate",           // ← not "latch"
    "headroom_after_paise": 110000
  },
  "authority": {                                 // B2 — under what rule
    "policy_version": 4,
    "mandate_id": "token_8812",
    "razorpay_payment_id": "pay_..."
  }
}
```

Read that object and you can reconstruct the entire justification for ₹400 leaving someone's account
without opening the database or reading any code. That is the deliverable B5 asks for.

Note `bound.enforced_by`. It is an enum, and the values are meaningfully different in strength:
`latch_policy` < `db_constraint` < `razorpay_mandate`. The trail does not merely claim a bound existed
— it names who would have stopped a breach.

---

## 5. Refusals — the vocabulary

Every gate and bound has one refusal code. Agents need stable, machine-readable failures far more than
humans need prose.

| Code | Cause | Agent's correct next move |
|---|---|---|
| `SLOT_TAKEN` | Lost the unique-index race | Call `find_slots` again |
| `HOLD_EXPIRED` | TTL elapsed before confirm | Re-hold |
| `HOLD_LIMIT_REACHED` | Too many concurrent holds | Release one |
| `POLICY_NOT_ACKNOWLEDGED` | Confirm attempted without reading ladder | Call `get_policy`, then retry |
| `POLICY_VERSION_STALE` | Ladder changed between read and confirm | Re-read and re-acknowledge |
| `MANDATE_CEILING_EXCEEDED` | Debit above `max_amount` | **Nothing.** Structurally refused |
| `LADDER_FORBIDS_MOVE` | Reschedule attempted too close in | Cancel instead, accepting the tier |
| `NOT_YET_ELIGIBLE` | No-show charge before start + grace | Wait |
| `MERCHANT_ACTION_REQUIRED` | No-show charge without merchant marking | **Nothing.** Agent cannot self-serve |
| `IDEMPOTENT_REPLAY` | Duplicate key | Use the returned prior result |

The two `Nothing` rows are the interesting ones. Most API errors tell a caller how to succeed. These
two tell it that no path exists — which is what a *bound* means, as opposed to a *validation error*.

---

## 6. Worked trace — the failure path

The brief's §6.4 scenario, as it will actually appear in the log. This is what the viewer renders and
what the video shows.

```
Thu 14:02:11  HOLD_CREATED          slot=thu-1600 practitioner=dr_rao ttl=600s
                                    gate: slot_free_at_request
                                    bound: 3 concurrent/agent  [enforced_by: db_constraint]
                                    money: none

Thu 14:03:48  POLICY_ACKNOWLEDGED   ladder v4  (≥48h free / 12–48h 50% / <12h 100%)
                                    deposit ₹300 · no-show ₹400 · ceiling ₹1,500

Thu 14:04:02  DEPOSIT_CAPTURED      ₹300 credit
                                    gate: live_hold + policy_acked
                                    bound: ₹300  [enforced_by: latch_policy]
                                    authority: policy v4 · pay_NkT8s2

Thu 14:04:03  MANDATE_REGISTERED    token_8812  ceiling ₹1,500  expires 2027-08-23
                                    bound: ₹1,500  [enforced_by: razorpay_mandate]

Thu 14:04:03  BOOKING_CONFIRMED     bkg_01JQ  thu-1600  dr_rao

── practitioner calls in sick ──────────────────────────────────────────────

Wed 11:20:33  MERCHANT_DECLINED     reason=practitioner_unavailable
                                    cause=MERCHANT → ladder NOT applied
                                    authority: merchant action, not agent inference

Wed 11:20:33  SLOT_RELEASED         thu-1600 returned to inventory

Wed 11:20:34  REFUND_ISSUED         ₹300 debit → original instrument  rfnd_4471
                                    gate: merchant_caused_cancellation
                                    bound: ≤ captured amount  [enforced_by: latch_policy]
                                    note: MDR ₹7.08 not recovered — borne by merchant

Wed 11:20:34  MANDATE_REVOKED       token_8812 released · ₹1,500 ceiling returned
                                    no orphaned authority remains

Wed 11:20:35  ALTERNATIVES_OFFERED  3 slots · same service · comparable practitioner
                                    computed by calendar query, not by a model

              ─────────────────────────────────────────────────
              net customer cost  ₹0
              net merchant revenue  ₹0   (−₹7.08 sunk MDR)
              orphaned mandates  0 · stranded holds  0 · manual tickets  0
              ─────────────────────────────────────────────────
```

Every line names its money action, its gate, its bound, its enforcer, and its authority. A judge
reading top to bottom can account for every rupee, and can see that the ladder was *deliberately not
applied* and why.

---

## 7. Where the concurrency actually bites

Two races exist. Both are handled at the storage layer, not in application code.

**Race 1 — two agents, one slot.** Handled by the partial unique index
(`01-architecture.md` §4). The loser gets `SLOT_TAKEN`.

**Race 2 — hold expiry vs. confirm.** The background worker decides a hold has expired at the same
moment `confirm_with_deposit` decides it is still live. Money could be captured against a released
slot.

Handled by taking `SELECT … FOR UPDATE` on the booking row in both paths. Whichever transaction
acquires the lock first wins; the other observes the committed outcome and behaves accordingly. The
confirm path re-reads TTL *inside* the lock, never before it.

> The general principle, applied consistently: **when correctness depends on a check and an action
> being one thing, they must be inside a database transaction, not adjacent lines of TypeScript.**
