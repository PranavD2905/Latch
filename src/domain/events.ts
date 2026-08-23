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
export type Instrument = 'card' | 'upi' | 'upi_mandate' | 'netbanking' | 'wallet'

/**
 * Which payment rail enforced a bound. `manual_capture` is the test-mode
 * stand-in built in Slice 4; `reserve_pay` is the documented production
 * rail, never built (dev-logs/005). Slice 3 introduces this ahead of Slice
 * 4's `AUTHORIZATION_HELD`/`AUTHORIZATION_RELEASED` work because
 * `AUTHORIZATION_RELEASED` is stubbed here and must still name a rail — the
 * trail must never be silent about which rail (if any) was in play.
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
 * The strength ordering matters: latch_policy < db_constraint < razorpay_mandate.
 */
export type BoundEnforcer = 'latch_policy' | 'db_constraint' | 'razorpay_mandate'

export interface BoundApplied {
  ceilingPaise: Paise
  enforcedBy: BoundEnforcer
  headroomAfterPaise: Paise
}

/** B2 — under which policy version / mandate / payment this action was authorised. */
export interface AuthorityRef {
  policyVersion: number
  mandateId?: string
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

export interface MandateRegisteredEvent extends EventBase {
  type: 'MANDATE_REGISTERED'
  mandateId: string
  ceilingPaise: Paise
  expiresAt: Date
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

export interface MandateRevokedEvent extends EventBase {
  type: 'MANDATE_REVOKED'
  mandateId: string
}

/**
 * Slice 3 stub for the release leg of the decline path. Real revocation
 * (Slice 4) has an actual `AUTHORIZATION_HELD` authorisation to abandon;
 * this slice never places one (no-show authorisation registration is
 * entirely Slice 4 scope), so there is nothing yet to release. The event is
 * still appended — the decline path's five-event shape is fixed now, so
 * Slice 4 only has to fill in `authorizationId` and stop stubbing, not add
 * a new event type or touch the transaction shape. `note` says plainly that
 * this run held no authorisation, rather than implying one was revoked.
 */
export interface AuthorizationReleasedEvent extends EventBase {
  type: 'AUTHORIZATION_RELEASED'
  authorizationId?: string
  rail: PaymentRail
  note: string
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

export interface NoShowChargedEvent extends EventBase, MoneyFields {
  type: 'NO_SHOW_CHARGED'
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
  | MandateRegisteredEvent
  | BookingConfirmedEvent
  | BookingRescheduledEvent
  | CancelledByCustomerEvent
  | RetentionAppliedEvent
  | RefundIssuedEvent
  | MerchantDeclinedEvent
  | SlotReleasedEvent
  | MandateRevokedEvent
  | AuthorizationReleasedEvent
  | AlternativesOfferedEvent
  | NoShowEligibleEvent
  | BookingCompletedEvent
  | NoShowChargedEvent
  | ActionRefusedEvent

export const MONEY_EVENT_TYPES = [
  'DEPOSIT_CAPTURED',
  'RETENTION_APPLIED',
  'REFUND_ISSUED',
  'NO_SHOW_CHARGED',
] as const satisfies readonly BookingEvent['type'][]

export type MoneyEventType = (typeof MONEY_EVENT_TYPES)[number]
