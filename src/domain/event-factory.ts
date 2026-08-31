import { ulid } from 'ulid'
import type { Clock } from '../ports/clock.js'
import type {
  ActionRefusedEvent,
  AlternativesOfferedEvent,
  BookingCompletedEvent,
  BookingConfirmedEvent,
  BookingEvent,
  BookingRescheduledEvent,
  CancelledByCustomerEvent,
  DepositCapturedEvent,
  EventBase,
  HoldCreatedEvent,
  HoldExpiredEvent,
  HoldReleasedEvent,
  MerchantDeclinedEvent,
  PaymentRequestedEvent,
  PolicyAcknowledgedEvent,
  ReconciliationMismatchEvent,
  RefundIssuedEvent,
  RetentionAppliedEvent,
  SessionCompleteAuthorizationHeldEvent,
  SessionCompleteAuthorizationLapsedEvent,
  SessionCompleteAuthorizationReleasedEvent,
  SessionCompleteChargedEvent,
  SlotReleasedEvent,
} from './events.js'

function baseFields(bookingId: string, sequence: number, clock: Clock): EventBase {
  return { eventId: ulid(), bookingId, occurredAt: clock.now(), sequence }
}

/**
 * Builds one factory function per event type. `T` is fixed at each call site
 * below, so `Omit<T, keyof EventBase | 'type'>` resolves to that event's exact
 * extra fields — for a money event, that's `action | gate | bound | authority`.
 * Passing an object literal missing any of them fails to compile: this is
 * "the constructor that refuses to omit them."
 */
function eventFactory<T extends BookingEvent>(type: T['type']) {
  return (bookingId: string, sequence: number, clock: Clock, fields: Omit<T, keyof EventBase | 'type'>): T => {
    return { ...baseFields(bookingId, sequence, clock), type, ...fields } as T
  }
}

export const createHoldCreatedEvent = eventFactory<HoldCreatedEvent>('HOLD_CREATED')
export const createHoldExpiredEvent = eventFactory<HoldExpiredEvent>('HOLD_EXPIRED')
export const createHoldReleasedEvent = eventFactory<HoldReleasedEvent>('HOLD_RELEASED')
export const createPolicyAcknowledgedEvent = eventFactory<PolicyAcknowledgedEvent>('POLICY_ACKNOWLEDGED')
export const createSessionCompleteAuthorizationHeldEvent = eventFactory<SessionCompleteAuthorizationHeldEvent>('SESSION_COMPLETE_AUTHORIZATION_HELD')
export const createSessionCompleteAuthorizationReleasedEvent = eventFactory<SessionCompleteAuthorizationReleasedEvent>('SESSION_COMPLETE_AUTHORIZATION_RELEASED')
export const createSessionCompleteAuthorizationLapsedEvent = eventFactory<SessionCompleteAuthorizationLapsedEvent>('SESSION_COMPLETE_AUTHORIZATION_LAPSED')
export const createBookingConfirmedEvent = eventFactory<BookingConfirmedEvent>('BOOKING_CONFIRMED')
export const createBookingRescheduledEvent = eventFactory<BookingRescheduledEvent>('BOOKING_RESCHEDULED')
export const createCancelledByCustomerEvent = eventFactory<CancelledByCustomerEvent>('CANCELLED_BY_CUSTOMER')
export const createMerchantDeclinedEvent = eventFactory<MerchantDeclinedEvent>('MERCHANT_DECLINED')
export const createSlotReleasedEvent = eventFactory<SlotReleasedEvent>('SLOT_RELEASED')
export const createAlternativesOfferedEvent = eventFactory<AlternativesOfferedEvent>('ALTERNATIVES_OFFERED')
export const createBookingCompletedEvent = eventFactory<BookingCompletedEvent>('BOOKING_COMPLETED')
export const createActionRefusedEvent = eventFactory<ActionRefusedEvent>('ACTION_REFUSED')
export const createReconciliationMismatchEvent = eventFactory<ReconciliationMismatchEvent>('RECONCILIATION_MISMATCH')
export const createPaymentRequestedEvent = eventFactory<PaymentRequestedEvent>('PAYMENT_REQUESTED')

// The money-moving events — action/gate/bound/authority are required by `fields`.
// No `createNoShowChargedEvent`/`createAuthorizationHeldEvent`/etc — the
// no-show feature is removed and nothing should ever construct one of those
// event types again; their type definitions stay in `events.ts` purely so
// `fold()` can keep replaying pre-removal history. See that file's own doc
// comments.
export const createDepositCapturedEvent = eventFactory<DepositCapturedEvent>('DEPOSIT_CAPTURED')
export const createRetentionAppliedEvent = eventFactory<RetentionAppliedEvent>('RETENTION_APPLIED')
export const createRefundIssuedEvent = eventFactory<RefundIssuedEvent>('REFUND_ISSUED')
export const createSessionCompleteChargedEvent = eventFactory<SessionCompleteChargedEvent>('SESSION_COMPLETE_CHARGED')
