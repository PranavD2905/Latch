import type { Paise } from './money.js'

/**
 * Fields every event carries, regardless of type.
 * occurredAt always comes from the Clock port — never Date.now() directly.
 * sequence is monotonic per booking, and is what the fold sorts on.
 */
export interface EventBase {
  eventId: string
  bookingId: string
  occurredAt: Date
  sequence: number
}

// ---------------------------------------------------------------------------
// The four mandatory fields on every money-moving event.
// docs/01-architecture.md Idea 2 / docs/03-domain-model.md §4.
// ---------------------------------------------------------------------------

export type MoneyDirection = 'credit' | 'debit'
export type Instrument = 'card' | 'upi' | 'netbanking' | 'wallet'

/**
 * Which payment rail enforced a bound. `manual_capture` is the test-mode
 * stand-in built in Slice 4 (`ManualCaptureRail`); `reserve_pay` is the
 * documented production rail, a stub-that-throws (`ReservePayRail`,
 * dev-logs/005). Slice 3 introduced this field ahead of Slice 4's
 * `AUTHORIZATION_HELD`/`AUTHORIZATION_RELEASED` work because
 * `AUTHORIZATION_RELEASED` was stubbed there and had to still name a rail —
 * the trail must never be silent about which rail (if any) was in play.
 */
export type PaymentRail = 'manual_capture' | 'reserve_pay'

/** B1 — which rupee moved, and in which direction. */
export interface MoneyAction {
  direction: MoneyDirection
  amountPaise: Paise
  instrument: Instrument
}

/** B4 — the precondition(s) that were satisfied to permit this action. */
export interface GateCleared {
  cleared: readonly string[]
  evidence: Record<string, unknown>
}

/**
 * B3 — the ceiling this action ran against, and who would have stopped a breach.
 * The strength ordering matters: latch_policy < db_constraint < payment_rail.
 * (Renamed from `razorpay_mandate` in Slice 4, dev-logs/005: the enforcing
 * rail now swaps via the `PaymentRail` port, so the enum names the role, not
 * one specific rail's mechanism.)
 */
export type BoundEnforcer = 'latch_policy' | 'db_constraint' | 'payment_rail'

export interface BoundApplied {
  ceilingPaise: Paise
  enforcedBy: BoundEnforcer
  headroomAfterPaise: Paise
}

/** B2 — under which policy version / authorisation / payment this action was authorised. */
export interface AuthorityRef {
  policyVersion: number
  /**
   * The authorisation this action cites. Set by `SESSION_COMPLETE_AUTHORIZATION_HELD`,
   * carried by `SESSION_COMPLETE_CHARGED` — the only live producer since the
   * no-show feature's removal. Historically also set by `AUTHORIZATION_HELD`
   * and carried by `NO_SHOW_CHARGED` (both historical-only now — see their
   * own doc comments); a pre-removal event citing one still round-trips
   * through this same field.
   */
  authorizationId?: string
  razorpayPaymentId?: string
  /**
   * Slice 3 addition, for `REFUND_ISSUED`: the payment being refunded and
   * the refund itself are two distinct Razorpay records. `razorpayPaymentId`
   * keeps naming the original payment (consistent with `DEPOSIT_CAPTURED`);
   * this carries the refund's own id so the trail can point at both.
   */
  razorpayRefundId?: string
}

/**
 * Mixed into every money-moving event type. There is no way to construct one
 * of those event types — via the type checker or via createXxxEvent() — without
 * supplying all four. That is the entire guarantee; see events.test.ts.
 */
export interface MoneyFields {
  action: MoneyAction
  gate: GateCleared
  bound: BoundApplied
  authority: AuthorityRef
}

// ---------------------------------------------------------------------------
// Event catalogue — docs/03-domain-model.md §4.
// Non-money events (no MoneyFields): the slot/hold/mandate/policy lifecycle.
// ---------------------------------------------------------------------------

export interface HoldCreatedEvent extends EventBase {
  type: 'HOLD_CREATED'
  practitionerId: string
  serviceId: string
  startsAt: Date
  ttlSeconds: number
}

export interface HoldExpiredEvent extends EventBase {
  type: 'HOLD_EXPIRED'
}

export interface HoldReleasedEvent extends EventBase {
  type: 'HOLD_RELEASED'
  releasedBy: 'agent' | 'system'
}

export interface PolicyAcknowledgedEvent extends EventBase {
  type: 'POLICY_ACKNOWLEDGED'
  policyVersion: number
}

/**
 * Slice 4 (dev-logs/005, replacing the never-built `MandateRegisteredEvent`).
 * Not a `MoneyFields` event — no money moves yet, `action.direction` would
 * be a lie. But B3's bound is real from this instant: `amountPaise` carries
 * the no-show fee, authorised at *exactly* that amount (dev-logs/005 —
 * "there is no headroom to abuse at all"), so `enforcedBy` is the fixed
 * literal `'payment_rail'` rather than the wider `BoundEnforcer` union —
 * this event can only ever claim the rail as its enforcer.
 *
 * **Historical-only as of the no-show feature's removal** (see the dev log
 * for that removal). No live code path constructs this event any more —
 * `confirm_with_deposit` never registers a no-show authorisation, so this
 * type exists purely so `fold()` and the audit-trail viewer can keep
 * correctly replaying/rendering any pre-removal booking whose history
 * already contains one. Never delete historical events from the trail, so
 * this stays in the `BookingEvent` union indefinitely — see
 * `NoShowChargedEvent`'s own doc comment for the fuller reasoning.
 */
export interface AuthorizationHeldEvent extends EventBase {
  type: 'AUTHORIZATION_HELD'
  authorizationId: string
  amountPaise: Paise
  /** `manual_expiry_period`, at its max (7200 minutes / 5 days) for `manual_capture` — docs/03-domain-model.md §4. */
  expiresAt: Date
  rail: PaymentRail
  enforcedBy: 'payment_rail'
  policyVersion: number
}

/**
 * The session-complete leg's mandate — same shape and same reasoning as
 * `AuthorizationHeldEvent`, but a structurally distinct event type rather
 * than one event with a `purpose` flag (the same "two event types, not one
 * with a flag that could be set wrong" discipline `SlotReleasedEvent`'s own
 * comment names). `amountPaise` is `service.pricePaise - policy.depositAmountPaise`
 * at confirm time — frozen onto this event and the booking projection the
 * instant it's authorised, so a merchant later raising or lowering the
 * service's price never retroactively changes what an already-confirmed
 * booking owes (the same discipline `authorizationAmountPaise` already
 * applies to the no-show fee).
 */
export interface SessionCompleteAuthorizationHeldEvent extends EventBase {
  type: 'SESSION_COMPLETE_AUTHORIZATION_HELD'
  authorizationId: string
  amountPaise: Paise
  expiresAt: Date
  rail: PaymentRail
  enforcedBy: 'payment_rail'
  policyVersion: number
}

/** The session-complete mandate's release leg — mirrors `AuthorizationReleasedEvent`. Appended when a booking resolves some other way (no-show charged, cancelled, declined) before the session ever completed, so no orphaned authority is left claiming the mandate is still live. */
export interface SessionCompleteAuthorizationReleasedEvent extends EventBase {
  type: 'SESSION_COMPLETE_AUTHORIZATION_RELEASED'
  authorizationId: string
  rail: PaymentRail
  expiresAt: Date
}

/** Mirrors `AuthorizationLapsedEvent` — the session-complete mandate's own 5-day manual-capture window expiring on a still-CONFIRMED booking before anyone captured or released it. */
export interface SessionCompleteAuthorizationLapsedEvent extends EventBase {
  type: 'SESSION_COMPLETE_AUTHORIZATION_LAPSED'
  authorizationId: string
  rail: PaymentRail
}

export interface BookingConfirmedEvent extends EventBase {
  type: 'BOOKING_CONFIRMED'
}

export interface BookingRescheduledEvent extends EventBase {
  type: 'BOOKING_RESCHEDULED'
  previousStartsAt: Date
  newStartsAt: Date
  /** 0 for a same-price move. A non-zero delta is not itself a MoneyFields event — see dev-logs/003. */
  priceDeltaPaise: Paise
}

export interface CancelledByCustomerEvent extends EventBase {
  type: 'CANCELLED_BY_CUSTOMER'
}

/**
 * `cause` is a literal `'MERCHANT'`, not the wider `'CUSTOMER' | 'MERCHANT'`
 * union — this event can only ever be constructed by the merchant-decline
 * path (`decline_booking`, Slice 3), so the type itself makes it impossible
 * to attach a customer-initiated cause to a merchant action. Rule 2,
 * docs/03-domain-model.md §3: cause is a required input, never inferred.
 * A customer-initiated cancellation is a *different* event
 * (`CANCELLED_BY_CUSTOMER`, Slice 5) — the two are structurally distinct
 * event types, not one event with a cause flag that could be set wrong.
 */
export interface MerchantDeclinedEvent extends EventBase {
  type: 'MERCHANT_DECLINED'
  reason: string
  cause: 'MERCHANT'
}

/**
 * Slice 3 addition. Referenced in docs/01-architecture.md §7 and
 * docs/03-domain-model.md §6's worked trace but missing from this
 * catalogue and from the original event union — the same kind of gap
 * dev-logs/003 found for `BOOKING_COMPLETED`. A merchant decline flips the
 * booking's projected status away from `confirmed` (via `MERCHANT_DECLINED`
 * in `fold()`), which is what actually frees the partial unique index —
 * `SLOT_RELEASED` is the audit-trail record of that fact, not a second
 * mechanism that makes it true.
 */
export interface SlotReleasedEvent extends EventBase {
  type: 'SLOT_RELEASED'
  practitionerId: string
  startsAt: Date
}

/**
 * The release leg of the decline path. Slice 3 appended this as a stub (no
 * real authorisation existed yet, so `authorizationId` was optional and a
 * free-text `note` explained why). Slice 4 fills it in for real: every
 * decline now points at the actual `AUTHORIZATION_HELD` authorisation it is
 * abandoning. `authorizationId` is required, and `note` is gone — replaced
 * by the structural `expiresAt` it carries over from that event. Razorpay
 * has no void endpoint (dev-logs/005): "released" means we simply never
 * capture, and Razorpay auto-refunds the authorisation at `expiresAt` on its
 * own. That makes release *asynchronous*, not an instant revoke — the trail
 * says so via `expiresAt` rather than implying otherwise.
 *
 * **Historical-only** since the no-show feature's removal (see the dev log
 * for that removal) — nothing releases a leg that can never again be
 * authorised. Kept in the union, same reasoning as `AuthorizationHeldEvent`:
 * a pre-removal booking's history may already contain one, and `fold()`
 * must keep replaying it correctly rather than lying about what happened.
 */
export interface AuthorizationReleasedEvent extends EventBase {
  type: 'AUTHORIZATION_RELEASED'
  authorizationId: string
  rail: PaymentRail
  expiresAt: Date
}

/**
 * Slice 4. Because a manual-capture authorisation has a finite life
 * (`manual_expiry_period` maxes at 5 days — dev-logs/005), the system must
 * know when it has *lost* its authority rather than discovering that only
 * when `charge_no_show` is attempted. A background worker appends this once
 * an authorisation's `expiresAt` has passed on a still-`CONFIRMED` booking.
 * Purely informational — it does not change the booking's projected status
 * (docs/03-domain-model.md §3: the booking just sits `CONFIRMED` with an
 * uncollectable no-show fee) — but from this point `charge_no_show` refuses
 * with `AUTHORIZATION_EXPIRED`, and a merchant reading the trail learns why,
 * instead of finding a silent failure.
 *
 * **Historical-only** since the no-show feature's removal — `charge_no_show`
 * and the authorisation-lapse worker's no-show half are both gone, so
 * nothing ever re-derives this eligibility again. Kept in the union so a
 * pre-removal booking's history still replays correctly.
 */
export interface AuthorizationLapsedEvent extends EventBase {
  type: 'AUTHORIZATION_LAPSED'
  authorizationId: string
  rail: PaymentRail
}

/**
 * Slice 4. The second of the two independent facts `charge_no_show` gates
 * on (docs/03-domain-model.md §3 Rule 3) — appended only by the merchant
 * API's mark-no-show route, never by any agent-facing path. `markedBy` is
 * the literal `'merchant'`, not a wider union: the same structural trick
 * `MerchantDeclinedEvent.cause` uses to make "an agent forged this" a
 * compile error rather than a runtime check.
 *
 * **Historical-only** since the no-show feature's removal — the merchant
 * API's mark-no-show route no longer exists. Kept in the union so a
 * pre-removal booking's history still replays correctly.
 */
export interface NonAttendanceMarkedEvent extends EventBase {
  type: 'NON_ATTENDANCE_MARKED'
  markedBy: 'merchant'
}

/**
 * `alternatives`, not `slotIds`: docs/03-domain-model.md §1 is explicit that
 * there is no `Slot` table and therefore no slot id — a slot is a computed
 * (practitionerId, serviceId, startsAt) tuple, exactly what `find_slots`
 * already returns. The original `slotIds: readonly string[]` field named a
 * concept that does not exist anywhere in the domain; fixed here rather
 * than inventing a fake id scheme to match it.
 */
export interface AlternativesOfferedEvent extends EventBase {
  type: 'ALTERNATIVES_OFFERED'
  alternatives: readonly { practitionerId: string; serviceId: string; startsAt: Date }[]
}

/**
 * **Historical-only** since the no-show feature's removal — the no-show-
 * eligibility background worker that used to append this is gone. Kept in
 * the union so a pre-removal booking's history still replays correctly; see
 * `NoShowChargedEvent`'s doc comment for the fuller reasoning.
 */
export interface NoShowEligibleEvent extends EventBase {
  type: 'NO_SHOW_ELIGIBLE'
}

/**
 * Not in the original catalogue — discovered missing while implementing fold().
 * docs/03-domain-model.md §3's diagram has "merchant marks attended -> COMPLETED"
 * with no corresponding event in §4. Added here and in the docs; see dev-logs/003.
 */
export interface BookingCompletedEvent extends EventBase {
  type: 'BOOKING_COMPLETED'
}

/** Refusals are events too — docs/03-domain-model.md §4 footnote ★★. */
export interface ActionRefusedEvent extends EventBase {
  type: 'ACTION_REFUSED'
  attemptedType: string
  refusalCode: string
  reason: string
}

/** One leg's pay link, as recorded on `PaymentRequestedEvent` — see that event's own doc comment. */
export interface PaymentRequestedLeg {
  leg: 'deposit' | 'no_show_authorization' | 'session_complete_authorization'
  orderId: string
  amountPaise: Paise
  label: string
}

/**
 * `confirm_with_deposit` returning a `PENDING` result (not a booking status —
 * see `ConfirmWithDepositResult` in `src/app/confirm-with-deposit.ts`) issues
 * one or more pay links and appends this so the trail explains the otherwise
 * unaccounted-for gap between `POLICY_ACKNOWLEDGED` and `DEPOSIT_CAPTURED`:
 * "we asked the customer for ₹300 at 14:04." Not a `MoneyFields` event — no
 * money has moved yet, `action.direction` would be a lie; this only records
 * that a request was made and what it was for. `orderId` is the rail's own
 * order identifier (an opaque string here, deliberately — no Razorpay type
 * crosses into `src/domain/`), the same id the `/pay` page resolves to build
 * Checkout against.
 */
export interface PaymentRequestedEvent extends EventBase {
  type: 'PAYMENT_REQUESTED'
  legs: readonly PaymentRequestedLeg[]
}

// ---------------------------------------------------------------------------
// Money-moving events — the four that carry MoneyFields.
// ---------------------------------------------------------------------------

export interface DepositCapturedEvent extends EventBase, MoneyFields {
  type: 'DEPOSIT_CAPTURED'
}

export interface RetentionAppliedEvent extends EventBase, MoneyFields {
  type: 'RETENTION_APPLIED'
}

export interface RefundIssuedEvent extends EventBase, MoneyFields {
  type: 'REFUND_ISSUED'
}

/**
 * The one money event whose settlement mechanism is genuinely swappable —
 * `rail` names which (dev-logs/005: "the trail must never imply the
 * production rail was exercised when it was not"). `DEPOSIT_CAPTURED` /
 * `REFUND_ISSUED` / `RETENTION_APPLIED` don't carry this field: the deposit
 * always settles through the same `PaymentProvider` Checkout capture
 * regardless of which `PaymentRail` is active, so there is no rail choice
 * for them to name. Narrower than dev-log 005's original "every money event
 * carries rail" — corrected here to where it's actually true.
 *
 * **Historical-only as of the no-show feature's removal** (product decision:
 * a post-hoc debit against a stored card is not how Indian merchants recover
 * a no-show — deposit forfeiture, the cancellation ladder's `hoursBefore: 0`
 * tier, already is; see the dev log for that removal). `charge_no_show` no
 * longer exists, so no live code path can ever construct one of these again
 * — but this type, and `'NO_SHOW_CHARGED'` in `MONEY_EVENT_TYPES` and
 * `BookingStatus` (`fold.ts`), stay exactly as they are, forever: the
 * `events` table is the source of truth and is never rewritten (docs/01-
 * architecture.md), so any booking that was actually charged for a no-show
 * before this removal must keep replaying to that same true historical
 * state — removing this type would make `fold()` unable to even parse that
 * booking's own recorded history, and remapping it to some other status
 * would make the trail confidently misreport what really happened, which is
 * the one thing this system's audit trail is built to never do (see
 * migration `0010_policies_immutable.sql`'s own framing of that same
 * principle for policy versions).
 */
export interface NoShowChargedEvent extends EventBase, MoneyFields {
  type: 'NO_SHOW_CHARGED'
  rail: PaymentRail
}

/**
 * The session-complete leg's charge — the merchant asserting the patient
 * actually attended, capturing the mandate authorised at confirm time
 * (`service.pricePaise - policy.depositAmountPaise`). Merchant-only, never
 * an MCP tool (same trust boundary as `NON_ATTENDANCE_MARKED`/`charge_no_show`'s
 * merchant-only mark — self-reported attendance from an agent is exactly
 * the kind of fact this system already refuses to take on an agent's say-so).
 * Unlike no-show's two-step mark-then-charge split (which exists only
 * because `charge_no_show` needed to stay agent-callable, gated on the
 * server's own elapsed-time fact), there is no analogous reason to split
 * this into two calls — one merchant action both marks and charges,
 * atomically, the same way `decline_booking` is one atomic merchant action.
 * Drives the booking to its real terminal `COMPLETED` status — the
 * transition `BOOKING_COMPLETED` was drawn for in the docs' state diagram
 * but that no code path ever actually fired.
 */
export interface SessionCompleteChargedEvent extends EventBase, MoneyFields {
  type: 'SESSION_COMPLETE_CHARGED'
  rail: PaymentRail
}

/**
 * The reconciliation worker / webhook handler's finding (docs/01-architecture.md
 * §1 Idea 1 taken one hop further out — dev-logs/014, the gap a Razorpay-
 * senior-SDE code review named: "if the response from Razorpay to Latch's own
 * server is lost after a capture actually succeeded, no event ever lands in
 * the trail." Not a `MoneyFields` event — it doesn't itself move money, it
 * *reports* a disagreement between what the trail says and what Razorpay's
 * own API (periodic worker) or an incoming webhook (real-time) currently
 * reports. `expectedStatus`/`expectedAmountPaise` are `'not_recorded'`/
 * `undefined` for the specific gap-1 case: Razorpay reports money moved for
 * this booking and the trail has no corresponding event at all.
 */
export interface ReconciliationMismatchEvent extends EventBase {
  type: 'RECONCILIATION_MISMATCH'
  /** Which leg of the booking's money this finding is about. */
  subject: 'deposit' | 'authorization' | 'unrecorded_payment'
  /** Razorpay's own id for the payment/authorization in question. */
  razorpayId: string
  /** What the trail currently says — `'not_recorded'` if nothing is there at all. */
  expectedStatus: string
  expectedAmountPaise: Paise | undefined
  /** What Razorpay's own API (or the webhook payload that triggered this check) reports right now. */
  actualStatus: string
  actualAmountPaise: Paise | undefined
  /** `'periodic_worker'` (docs/01-architecture.md §8, reconciliation worker) or `'webhook'` (real-time, POST /webhooks/razorpay). */
  detectedVia: 'periodic_worker' | 'webhook'
}

// ---------------------------------------------------------------------------
// The union. This is the type `fold()` folds over.
// ---------------------------------------------------------------------------

export type BookingEvent =
  | HoldCreatedEvent
  | HoldExpiredEvent
  | HoldReleasedEvent
  | PolicyAcknowledgedEvent
  | DepositCapturedEvent
  | AuthorizationHeldEvent
  | SessionCompleteAuthorizationHeldEvent
  | SessionCompleteAuthorizationReleasedEvent
  | SessionCompleteAuthorizationLapsedEvent
  | SessionCompleteChargedEvent
  | BookingConfirmedEvent
  | BookingRescheduledEvent
  | CancelledByCustomerEvent
  | RetentionAppliedEvent
  | RefundIssuedEvent
  | MerchantDeclinedEvent
  | SlotReleasedEvent
  | AuthorizationReleasedEvent
  | AuthorizationLapsedEvent
  | AlternativesOfferedEvent
  | NoShowEligibleEvent
  | NonAttendanceMarkedEvent
  | BookingCompletedEvent
  | NoShowChargedEvent
  | ActionRefusedEvent
  | ReconciliationMismatchEvent
  | PaymentRequestedEvent

export const MONEY_EVENT_TYPES = [
  'DEPOSIT_CAPTURED',
  'RETENTION_APPLIED',
  'REFUND_ISSUED',
  'NO_SHOW_CHARGED',
  'SESSION_COMPLETE_CHARGED',
] as const satisfies readonly BookingEvent['type'][]

export type MoneyEventType = (typeof MONEY_EVENT_TYPES)[number]
