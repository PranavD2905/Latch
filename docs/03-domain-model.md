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

**A clarification on "never update," since it is easy to over-read.** `01-architecture.md`'s "nothing
is ever updated" describes the `events` table — that one truly is insert-only, forever. The `bookings`
projection is different: the same row's `status` column changes via ordinary SQL `UPDATE` as the
booking moves through its lifecycle (held → confirmed → cancelled, etc.), because the partial unique
index needs a single stable row per booking to apply against. The rule is not "no SQL `UPDATE`
anywhere" — it is "the projection is never the thing you write *to* without a causing event; every
such `UPDATE` happens in the same transaction as the event `INSERT` that derived it, so the two can
never be observed out of sync."

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
    "fee_paise": 40000,                   // ₹400 — ALSO the authorised amount; there is no headroom
    "grace_minutes": 15
  },
  "hold_ttl_seconds": 600,                // 10 minutes
  "max_concurrent_holds_per_agent": 3,
  "hold_rate_limit_per_minute": 10        // dev-logs/014: request-rate ceiling, independent of the concurrent-hold count above
}
```

**Why versioned.** A booking made under ladder v4 must be cancelled under ladder v4, even if the
merchant has since published v5. Money rules cannot change retroactively on a customer who already
committed. Every event carries the `policy_version` it acted under, so the trail explains itself years
later without needing to know what the policy is *today*.

**Demonstrated, not just asserted, as of dev-logs/015.** `set_policy` (`src/app/set-policy.ts`) is the
write path that makes this claim testable end to end: it publishes a new version as an INSERT, never an
UPDATE, so an old version's row — and every event that cites it — is untouched forever.
`src/app/set-policy-retroactivity.integration.test.ts` books and confirms under whatever version is
active, publishes a new version with a deliberately different ladder, and then cancels the original
booking — the retained/refunded amounts, and the `authority.policyVersion` on the resulting
`RETENTION_APPLIED`/`REFUND_ISSUED` events, all still cite the *original* version, never the new one.

This single field is most of bar clause **B2**. "Why was ₹400 retained?" is answered by "ladder v4,
tier `hours_before: 12`, `retain_pct: 50`, on a ₹800 service" — a complete causal account, with no
database lookup required.

### The ladder evaluator

The only genuinely subtle piece of logic in the system, so it is specified exactly.

```
evaluateLadder(ladder, appointmentStart, now) → { tier, retain_pct }

  hoursUntil = (appointmentStart - now) / 3_600_000        // now comes from the Clock port

  return the FIRST tier (descending hours_before) where hoursUntil >= tier.hours_before,
  OR the last tier (smallest hours_before) if none matched — see the note below.
```

**Docs correction made in Slice 1 (dev-logs/004).** The original phrasing — "the first tier where
`hoursUntil >= tier.hours_before`" — is ambiguous for an already-started or past-dated appointment.
With the ladder above, `hoursUntil = -2.0` fails `-2 >= 0`, so a strict reading matches **no** tier at
all, even though this document's own worked-example table (below) lists `hoursUntil = -2.0` as
matching the `hours_before: 0` tier at 100% retention. The fix: the ladder's last tier in descending
order — by convention `hours_before: 0`, the floor — is a **catch-all**. It matches not just
`hoursUntil >= 0`, but everything below that too, because there is no lower tier left to hand the case
to. The ladder must be total over all of `(-infinity, +infinity)`, not just `[0, +infinity)`. This
reproduces every row of the table exactly, including the negative one, and is what
`src/domain/ladder.ts` implements.

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
       │  · authorisation registered
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
        │                              authorisation released;
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

**A note on where `NO_SHOW_ELIGIBLE` actually lives, added in Slice 5.** This diagram (and a pure
`fold()` replay of the event log) shows it as a real intermediate state between `CONFIRMED` and
`charge_no_show`. The live Postgres projection every command handler actually gates against
deliberately does not track it that way: the no-show-eligibility background worker
(`src/app/no-show-eligibility-worker.ts`) appends `NO_SHOW_ELIGIBLE` without changing the projection's
`status` column, which stays `confirmed`. This matches `charge_no_show`'s own gate (dev-logs/009, which
re-derives eligibility from the clock directly rather than depending on this event) and means `cancel`
and `reschedule` never have to special-case a booking that's practically still confirmed but
technically past its no-show window. The event still lands in the trail, in order, exactly where the
diagram shows it — only the projected `status` field stays put.

### Reschedule deserves a note

Reschedule is a **self-transition**, not a cancel-and-rebook. `CONFIRMED → CONFIRMED`, same booking id,
same deposit, same authorisation, new `starts_at`.

This is brief §2.3 property #6 taken literally: *"Not return, not refund — a move."* Implementing it as
cancel-then-rebook would refund the deposit (losing ₹7.08 in unrecoverable MDR — see cost model), void
the authorisation, and re-run the whole gate sequence. It would also break the audit trail's narrative: the
history should read as one booking that moved, because that is what happened.

The gate is a conjunction: the target slot must be free **and** the ladder must permit a move at the
current time-to-appointment. A customer cannot dodge a 100% cancellation penalty by rescheduling into
next month and cancelling for free from there — the ladder is evaluated at the moment of the
reschedule request, against the *original* appointment time.

**What "permits a move" means, pinned down in Slice 5** (`src/app/reschedule-booking.ts`): the ladder
tier at the current time-to-appointment must retain 0%. Any tier that would retain something on a
cancellation also forbids a move — a customer inside the 50% or the 100% tier must cancel and accept
that tier, not move. This is what closes the dodge structurally: a booking can never reach "next
month" while it sits inside a retention tier, because the move itself is refused (`LADDER_FORBIDS_MOVE`)
before the ladder is ever re-evaluated against a new date.

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
| `AUTHORIZATION_HELD` | — | card manual capture token created, ceiling recorded — the no-show leg |
| `SESSION_COMPLETE_AUTHORIZATION_HELD` | — | A second, independent card manual-capture token created alongside the deposit — `service.pricePaise - policy.depositAmountPaise`, frozen at confirm time (added with the session-complete charge feature; see the note after this table) |
| `SESSION_COMPLETE_AUTHORIZATION_RELEASED` | — | The session-complete mandate abandoned unused — a no-show charge made it moot |
| `SESSION_COMPLETE_AUTHORIZATION_LAPSED` | — | Worker: the session-complete leg's own 5-day authorisation window expired before it was captured |
| `SESSION_COMPLETE_CHARGED` | **in** | `mark_complete` captures the session-complete mandate |
| `BOOKING_CONFIRMED` | — | The deposit capture (and any authorisation legs the policy/price called for) succeeded |
| `BOOKING_RESCHEDULED` | delta only | Move succeeded |
| `CANCELLED_BY_CUSTOMER` | — | Cancel with `cause=CUSTOMER` |
| `RETENTION_APPLIED` | **kept** | Ladder retained a portion |
| `REFUND_ISSUED` | **out** | Razorpay refund succeeds |
| `MERCHANT_DECLINED` | — | Merchant declines a confirmed booking ★ |
| `SLOT_RELEASED` | — | The declined booking's slot returns to inventory ★ |
| `AUTHORIZATION_RELEASED` | — | Authorisation abandoned — never captured, left to lapse |
| `ALTERNATIVES_OFFERED` | — | Replacement slots computed and pushed |
| `AUTHORIZATION_LAPSED` | — | Worker: the 5-day authorisation window expired before the appointment |
| `NO_SHOW_ELIGIBLE` | — | Start + grace elapsed |
| `NON_ATTENDANCE_MARKED` | — | Merchant API marks non-attendance — the second of `charge_no_show`'s two independent facts |
| `NO_SHOW_CHARGED` | **in** | Debit against authorisation succeeded |
| `BOOKING_COMPLETED` | — | `mark_complete`, when there is no session-complete mandate to capture (service priced exactly at the deposit) — the fact of completion with no money attached |
| `ACTION_REFUSED` | — | A gate or bound rejected a command ★★ |
| `RECONCILIATION_MISMATCH` | — | The reconciliation worker or the Razorpay webhook found the trail disagreeing with Razorpay's own record ★★★ |

★ the B5 failure path. `AUTHORIZATION_RELEASED` is also part of it. Slice 3 appended it as a stub
(`rail`, a free-text `note`, no `authorizationId`) because no-show authorisation registration was
entirely Slice 4 scope at the time. Slice 4 fills it in for real: every decline now carries the actual
`authorizationId` off the `AUTHORIZATION_HELD` it is abandoning, plus `expiresAt` (carried over from that
same event) in place of the free-text `note` — a structural fact ("this clears automatically at this
timestamp, not now") in place of prose. The event type and its place in the five-event decline
transaction never changed.
★★ **Refusals are events too.** When an agent tries to exceed a bound or skip a gate, that attempt is
recorded permanently. This is what lets the demo *show the bound working* rather than merely assert it
exists — a judge can watch an over-limit charge be refused and see the refusal land in the trail with
its reason.

★★★ **dev-logs/014.** Not a money event, and it never changes a booking's projected `status` (see
`fold()`'s treatment, same as `ACTION_REFUSED`) — it *reports* a disagreement, it does not resolve one.
Carries `subject` (`deposit` | `authorization` | `unrecorded_payment`), the Razorpay id in question,
what the trail expected, what was actually observed, and `detectedVia` (`periodic_worker` | `webhook`).
Deduplicated against the most recently recorded finding for the same subject+id, so a persistent,
unresolved mismatch is recorded once, not every tick.

**A note on ordering the log for display, added in Slice 6.** `occurredAt` is a domain timestamp off the
`Clock` port, and integration tests legitimately run a `FrozenClock` far into the future to simulate
elapsed time (e.g. a no-show's grace period) — those rows land for real in the shared dev database with
`occurredAt` nowhere near actual insertion time. `eventId`'s ULID is no safer: its sub-millisecond
ordering is random, not causal, and a single multi-event transaction (e.g. `decline_booking`'s five-event
write) appends every one of its rows within the same millisecond, so sorting by `eventId` can shuffle them
— this was caught live-testing the Slice 6 viewer against a real decline. The `events` table therefore
carries a `global_sequence` `bigserial` column (migration `0008`), true row-insertion order, independent
of any domain timestamp — the SSE audit-trail feed (`src/adapters/audit-trail/`) orders and pages by that
column exclusively, never by `occurredAt` or `eventId`.

**A note on where the session-complete leg actually lives, added with the session-complete charge
feature — the same shape as the `NO_SHOW_ELIGIBLE` note above.** `fold()` (`src/domain/fold.ts`)
deliberately treats `SESSION_COMPLETE_AUTHORIZATION_HELD`/`_RELEASED`/`_LAPSED` as no-ops: `BookingState`,
the pure fold's return type, carries a single `authorizationId` field, modelling the no-show leg only.
The session-complete leg's authorisation id, amount, and expiry live on the live Postgres projection's own
dedicated columns (`sessionCompleteAuthorizationId` and friends, migration `0013`), set directly by
`confirm-with-deposit.ts`/`mark-session-complete.ts`, never derived from a replay. This is not an
oversight — it is the same divergence the `NO_SHOW_ELIGIBLE` note above already established as this
project's precedent: a pure `fold()` over the event log is the reference domain model
`docs/03-domain-model.md` describes and `fold.test.ts` exercises directly, but it is not, and was never
meant to be, the thing any command handler actually reads at runtime. The live projection (`BookingSnapshot`,
`src/ports/event-store.ts`) is a superset of `fold()`'s `BookingState`, carrying whatever additional
operational bookkeeping (`holdExpiresAt`, `agentId`, both authorisation legs' full detail, the no-show/
no-show-eligibility markers) a command handler's own gate needs without a full replay per call — see
dev-logs/010 for why that split was made in the first place. The event still lands in the trail, in
order, exactly where a real replay would show it; only `fold()`'s own projected fields stay narrower than
the live one's.

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
    "instrument": "card"
  },
  "gate": {                                      // B4 — what permitted it
    "cleared": ["start_time_elapsed", "merchant_marked_non_attendance"],
    "evidence": { "started_at": "...", "marked_by": "merchant", "marked_at": "..." }
  },
  "bound": {                                     // B3 — the ceiling, and who holds it
    "ceiling_paise": 40000,                      // the authorised amount itself
    "enforced_by": "payment_rail",               // ← not "latch"
    "headroom_after_paise": 0                    // authorised at exactly the fee: no slack
  },
  "rail": "manual_capture",                      // test-mode stand-in; prod rail is reserve_pay
  "authority": {                                 // B2 — under what rule
    "policy_version": 4,
    "authorization_id": "pay_Auth991",
    "razorpay_payment_id": "pay_..."
  }
}
```

Read that object and you can reconstruct the entire justification for ₹400 leaving someone's account
without opening the database or reading any code. That is the deliverable B5 asks for.

Note `bound.enforced_by`. It is an enum, and the values are meaningfully different in strength:
`latch_policy` < `db_constraint` < `payment_rail`. The trail does not merely claim a bound existed
— it names who would have stopped a breach.

**`rail` appears on `NO_SHOW_CHARGED` only, not on every money event.** Narrower than dev-log 005's
original phrasing ("every money event carries `rail`"). `DEPOSIT_CAPTURED` / `RETENTION_APPLIED` /
`REFUND_ISSUED` always settle through the same `PaymentProvider` Checkout capture regardless of which
`PaymentRail` is active — there is no rail choice for them to name. `AUTHORIZATION_HELD` /
`AUTHORIZATION_RELEASED` / `AUTHORIZATION_LAPSED` carry it too, since they're the events that name which
rail is holding the authority in the first place.

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
| `CAPTURE_AMOUNT_MISMATCH` | Capture ≠ authorised amount | **Nothing.** Structurally refused |
| `LADDER_FORBIDS_MOVE` | Reschedule attempted too close in | Cancel instead, accepting the tier |
| `NOT_YET_ELIGIBLE` | No-show charge before start + grace | Wait |
| `MERCHANT_ACTION_REQUIRED` | No-show charge without merchant marking | **Nothing.** Agent cannot self-serve |
| `AUTHORIZATION_EXPIRED` | The 5-day authorisation window lapsed before the appointment | **Nothing.** Authority is gone; the no-show is uncollectable and the trail says why |
| `IDEMPOTENT_REPLAY` | Duplicate key | Use the returned prior result |
| `RATE_LIMITED` | Too many `hold_slot` successes from this agent in the rolling window | Wait for the window to roll forward |

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

Thu 14:04:03  AUTHORIZATION_HELD    pay_Auth991  authorised ₹400  lapses in 5d
                                    bound: ₹400 — the authorised amount IS the ceiling
                                    [enforced_by: payment_rail] · rail: manual_capture

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

Wed 11:20:34  AUTHORIZATION_RELEASED       pay_Auth991 abandoned — never captured
                                    rail: manual_capture · auto-refunds at expiry
                                    no orphaned authority remains

Wed 11:20:35  ALTERNATIVES_OFFERED  3 slots · same service · comparable practitioner
                                    computed by calendar query, not by a model

              ─────────────────────────────────────────────────
              net customer cost  ₹0
              net merchant revenue  ₹0   (−₹7.08 sunk MDR)
              orphaned authorisations  0 · stranded holds  0 · manual tickets  0
              ─────────────────────────────────────────────────
```

Every line names its money action, its gate, its bound, its enforcer, and its authority. A judge
reading top to bottom can account for every rupee, and can see that the ladder was *deliberately not
applied* and why.

**Confirmed against a real Razorpay refund** (`src/app/decline-booking.live.integration.test.ts`): the
five decline-path lines above (`MERCHANT_DECLINED` → `SLOT_RELEASED` → `REFUND_ISSUED` →
`AUTHORIZATION_RELEASED` → `ALTERNATIVES_OFFERED`) match exactly, in order, in one transaction.
`AUTHORIZATION_HELD`/`AUTHORIZATION_RELEASED` themselves are proven against `FakePaymentRail` — which
reproduces `ManualCaptureRail`'s real behaviour exactly, including the item-7 ceiling refusal — and
against real Razorpay for order creation (`manual-capture-rail.live.integration.test.ts`); a real
authorised payment landing and being captured needs a human at Checkout (dev-logs/006/007), which is
carried forward rather than blocking Slice 4 (`dev-logs/009`).

**The no-show-charge path, the other half of this slice**, does not run through decline — it is the
booking's alternate ending when the patient never shows up at all:

```
── 15 minutes past the appointment, patient never arrived ─────────────────

Thu 16:15:41  NON_ATTENDANCE_MARKED  marked_by=merchant
                                    (merchant API only — no agent-facing path can forge this)

Thu 16:16:02  NO_SHOW_CHARGED       ₹400 debit  pay_Auth991
                                    gate: start_time_elapsed + merchant_marked_non_attendance
                                    bound: ₹400  [enforced_by: payment_rail] · headroom after: ₹0
                                    rail: manual_capture · authority: policy v4 · pay_Auth991
```

Two independent facts, from two different authorities, both satisfied before either event lands — an
agent calling `charge_no_show` a minute earlier (`NOT_YET_ELIGIBLE`) or before the merchant marks
non-attendance (`MERCHANT_ACTION_REQUIRED`) is refused, and that refusal is itself in the trail
(`src/app/charge-no-show.integration.test.ts`).

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
