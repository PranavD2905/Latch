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

export interface MerchantDeclinedEvent extends EventBase {
  type: 'MERCHANT_DECLINED'
  reason: string
}

export interface MandateRevokedEvent extends EventBase {
  type: 'MANDATE_REVOKED'
  mandateId: string
}

export interface AlternativesOfferedEvent extends EventBase {
  type: 'ALTERNATIVES_OFFERED'
  slotIds: readonly string[]
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
  | MandateRevokedEvent
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
