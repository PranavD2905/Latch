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
  MandateRegisteredEvent,
  MandateRevokedEvent,
  MerchantDeclinedEvent,
  NoShowChargedEvent,
  NoShowEligibleEvent,
  PolicyAcknowledgedEvent,
  RefundIssuedEvent,
  RetentionAppliedEvent,
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
export const createMandateRegisteredEvent = eventFactory<MandateRegisteredEvent>('MANDATE_REGISTERED')
export const createBookingConfirmedEvent = eventFactory<BookingConfirmedEvent>('BOOKING_CONFIRMED')
export const createBookingRescheduledEvent = eventFactory<BookingRescheduledEvent>('BOOKING_RESCHEDULED')
export const createCancelledByCustomerEvent = eventFactory<CancelledByCustomerEvent>('CANCELLED_BY_CUSTOMER')
export const createMerchantDeclinedEvent = eventFactory<MerchantDeclinedEvent>('MERCHANT_DECLINED')
export const createMandateRevokedEvent = eventFactory<MandateRevokedEvent>('MANDATE_REVOKED')
export const createAlternativesOfferedEvent = eventFactory<AlternativesOfferedEvent>('ALTERNATIVES_OFFERED')
export const createNoShowEligibleEvent = eventFactory<NoShowEligibleEvent>('NO_SHOW_ELIGIBLE')
export const createBookingCompletedEvent = eventFactory<BookingCompletedEvent>('BOOKING_COMPLETED')
export const createActionRefusedEvent = eventFactory<ActionRefusedEvent>('ACTION_REFUSED')

// The four money-moving events — action/gate/bound/authority are required by `fields`.
export const createDepositCapturedEvent = eventFactory<DepositCapturedEvent>('DEPOSIT_CAPTURED')
export const createRetentionAppliedEvent = eventFactory<RetentionAppliedEvent>('RETENTION_APPLIED')
export const createRefundIssuedEvent = eventFactory<RefundIssuedEvent>('REFUND_ISSUED')
export const createNoShowChargedEvent = eventFactory<NoShowChargedEvent>('NO_SHOW_CHARGED')
