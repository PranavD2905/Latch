import type { BookingEvent } from './events.js'

/**
 * The nine states from docs/03-domain-model.md §3. HELD/CONFIRMED/NO_SHOW_ELIGIBLE
 * are "live" — the rest are terminal.
 *
 * `NO_SHOW_ELIGIBLE` and `NO_SHOW_CHARGED` are **historical-only** since the
 * no-show feature's removal (see the dev log for that removal): no live code
 * path can ever produce either again (the no-show-eligibility worker and
 * `charge_no_show` are both deleted), but a pre-removal booking's history may
 * already end in one, and `fold()` — a pure replay of the permanent `events`
 * table — must keep reporting that true historical state rather than
 * remapping it to something that didn't actually happen.
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
 *
 * Not the live projection: `fold()` is the pure reference domain model
 * docs/03-domain-model.md describes, exercised directly by `fold.test.ts`
 * — no command handler calls it at runtime. The live Postgres projection
 * every handler actually gates against is `BookingSnapshot`
 * (`src/ports/event-store.ts`), a superset of this type carrying whatever
 * extra operational bookkeeping (`holdExpiresAt`, `agentId`, both
 * authorisation legs' full detail, the no-show-eligibility marker) a
 * handler needs without a full replay per call, maintained directly by each
 * handler rather than derived from this function. `NO_SHOW_ELIGIBLE`
 * (docs/03-domain-model.md §3, added Slice 5) and the
 * `SESSION_COMPLETE_AUTHORIZATION_*` case below (added with the
 * session-complete charge feature) are the two places that divergence is
 * visible in this file; see dev-logs/010 for why the split was made.
 */
export interface BookingState {
  bookingId: string
  status: BookingStatus
  practitionerId: string | undefined
  startsAt: Date | undefined
  policyVersion: number | undefined
  authorizationId: string | undefined
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

    case 'AUTHORIZATION_HELD':
      next.authorizationId = event.authorizationId
      return next

    case 'SESSION_COMPLETE_AUTHORIZATION_HELD':
    case 'SESSION_COMPLETE_AUTHORIZATION_RELEASED':
    case 'SESSION_COMPLETE_AUTHORIZATION_LAPSED':
      // Informational, same treatment fold() already gives AUTHORIZATION_RELEASED/
      // LAPSED — the live Postgres projection tracks this leg's authorizationId
      // via its own dedicated column, not through a pure replay of this event.
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

    case 'AUTHORIZATION_RELEASED':
      next.authorizationId = undefined
      return next

    case 'NO_SHOW_ELIGIBLE':
      next.status = 'NO_SHOW_ELIGIBLE'
      return next

    case 'NO_SHOW_CHARGED':
      next.status = 'NO_SHOW_CHARGED'
      return next

    case 'SESSION_COMPLETE_CHARGED':
      next.status = 'COMPLETED'
      return next

    case 'BOOKING_COMPLETED':
      next.status = 'COMPLETED'
      return next

    // Informational events: they happened, and lastEventSequence already
    // advanced above, but they do not change status or the projected fields.
    // SLOT_RELEASED in particular: the booking already left ('held'|'confirmed')
    // when MERCHANT_DECLINED set status above — this event records the fact,
    // it isn't what makes the partial unique index stop blocking the slot.
    case 'DEPOSIT_CAPTURED':
    case 'RETENTION_APPLIED':
    case 'REFUND_ISSUED':
    case 'SLOT_RELEASED':
    case 'AUTHORIZATION_LAPSED':
    case 'ALTERNATIVES_OFFERED':
    case 'NON_ATTENDANCE_MARKED':
    case 'ACTION_REFUSED':
    // dev-logs/014: a reported disagreement, not a state transition — it
    // never changes what a pure replay believes the booking's status is,
    // same as ACTION_REFUSED above.
    case 'RECONCILIATION_MISMATCH':
    // No money moved and the booking stays HELD — PENDING is a result shape
    // `confirm_with_deposit` returns, never a booking status (see that
    // command's own doc comment). This just records that a pay link was
    // issued.
    case 'PAYMENT_REQUESTED':
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
    authorizationId: undefined,
    lastEventSequence: 0,
  }

  for (const event of sorted) {
    state = applyEvent(state, event)
  }

  return state
}
