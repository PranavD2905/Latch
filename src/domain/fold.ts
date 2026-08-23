import type { BookingEvent } from './events.js'

/**
 * The nine states from docs/03-domain-model.md §3. HELD/CONFIRMED/NO_SHOW_ELIGIBLE
 * are "live" — the rest are terminal.
 */
export type BookingStatus =
  | 'HELD'
  | 'EXPIRED'
  | 'RELEASED'
  | 'CONFIRMED'
  | 'CANCELLED_BY_CUSTOMER'
  | 'DECLINED_BY_MERCHANT'
  | 'NO_SHOW_ELIGIBLE'
  | 'NO_SHOW_CHARGED'
  | 'COMPLETED'

/**
 * The projection — a derived, disposable view over the event log, never the
 * source of truth itself. Everything here is computable by replaying events;
 * nothing here is ever assigned directly.
 */
export interface BookingState {
  bookingId: string
  status: BookingStatus
  practitionerId: string | undefined
  startsAt: Date | undefined
  policyVersion: number | undefined
  mandateId: string | undefined
  lastEventSequence: number
}

export class EmptyEventLogError extends Error {
  constructor() {
    super('Cannot fold an empty event list — a booking always begins with HOLD_CREATED')
    this.name = 'EmptyEventLogError'
  }
}

export class MixedBookingIdsError extends Error {
  constructor() {
    super('fold() received events from more than one bookingId')
    this.name = 'MixedBookingIdsError'
  }
}

function applyEvent(state: BookingState, event: BookingEvent): BookingState {
  const next: BookingState = { ...state, lastEventSequence: event.sequence }

  switch (event.type) {
    case 'HOLD_CREATED':
      next.status = 'HELD'
      next.practitionerId = event.practitionerId
      next.startsAt = event.startsAt
      return next

    case 'HOLD_EXPIRED':
      next.status = 'EXPIRED'
      return next

    case 'HOLD_RELEASED':
      next.status = 'RELEASED'
      return next

    case 'POLICY_ACKNOWLEDGED':
      next.policyVersion = event.policyVersion
      return next

    case 'MANDATE_REGISTERED':
      next.mandateId = event.mandateId
      return next

    case 'BOOKING_CONFIRMED':
      next.status = 'CONFIRMED'
      return next

    case 'BOOKING_RESCHEDULED':
      next.startsAt = event.newStartsAt
      return next

    case 'CANCELLED_BY_CUSTOMER':
      next.status = 'CANCELLED_BY_CUSTOMER'
      return next

    case 'MERCHANT_DECLINED':
      next.status = 'DECLINED_BY_MERCHANT'
      return next

    case 'MANDATE_REVOKED':
      next.mandateId = undefined
      return next

    case 'NO_SHOW_ELIGIBLE':
      next.status = 'NO_SHOW_ELIGIBLE'
      return next

    case 'NO_SHOW_CHARGED':
      next.status = 'NO_SHOW_CHARGED'
      return next

    case 'BOOKING_COMPLETED':
      next.status = 'COMPLETED'
      return next

    // Informational events: they happened, and lastEventSequence already
    // advanced above, but they do not change status or the projected fields.
    case 'DEPOSIT_CAPTURED':
    case 'RETENTION_APPLIED':
    case 'REFUND_ISSUED':
    case 'ALTERNATIVES_OFFERED':
    case 'ACTION_REFUSED':
      return next
  }
}

/**
 * Pure. Sorts by sequence, then replays every event to derive current state.
 * docs/03-domain-model.md §3.
 */
export function fold(events: readonly BookingEvent[]): BookingState {
  if (events.length === 0) {
    throw new EmptyEventLogError()
  }

  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)
  const bookingId = sorted[0]!.bookingId
  if (sorted.some((e) => e.bookingId !== bookingId)) {
    throw new MixedBookingIdsError()
  }

  let state: BookingState = {
    bookingId,
    status: 'HELD', // overwritten by the first event's transition (always HOLD_CREATED in practice)
    practitionerId: undefined,
    startsAt: undefined,
    policyVersion: undefined,
    mandateId: undefined,
    lastEventSequence: 0,
  }

  for (const event of sorted) {
    state = applyEvent(state, event)
  }

  return state
}
