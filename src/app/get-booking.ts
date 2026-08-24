import type { BookingSnapshot } from '../ports/event-store.js'
import type { AppDeps } from './types.js'

export class BookingNotFoundError extends Error {}

export interface GetBookingCommand {
  bookingId: string
}

export interface GetBookingResult {
  booking: BookingSnapshot
}

/**
 * `get_booking` — read-only status, no gate, no money. Exists specifically
 * to give an agent something to reconcile against when a write times out:
 * `hold_slot`/`confirm_with_deposit`/etc. can all succeed on the server
 * while the response never reaches the caller — a slow human-in-the-loop
 * Checkout wait outlasting an intermediate proxy's idle-connection timeout
 * is a real example, not a hypothetical one. Before this tool existed, an
 * agent facing a timed-out write had nothing to check against but
 * `find_slots`, which can't distinguish a live hold from a confirmed
 * booking, let alone report deposit/authorisation state. This is the one
 * tool that's always safe to retry.
 */
export async function getBooking(cmd: GetBookingCommand, deps: AppDeps): Promise<GetBookingResult> {
  const booking = await deps.eventStore.loadSnapshot(cmd.bookingId)
  if (!booking) {
    throw new BookingNotFoundError(`unknown booking: ${cmd.bookingId}`)
  }
  return { booking }
}
