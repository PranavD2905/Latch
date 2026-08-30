import type { OutstandingPaymentLeg } from './confirm-with-deposit.js'
import { checkAllPendingLegs } from './pending-payment-status.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { ownedByMerchant } from './tenant-guard.js'
import type { AppDeps } from './types.js'

export class BookingNotFoundError extends Error {}

export interface GetBookingCommand {
  bookingId: string
}

export interface GetBookingResult {
  booking: BookingSnapshot
  /**
   * Payment-link feature follow-up: live status for whichever legs
   * `confirm_with_deposit` has issued a pay link for and hasn't finalized
   * yet. `undefined` when there's nothing pending (never requested, or
   * already fully confirmed — `pendingPaymentLegs` is cleared the instant
   * the booking's finalize transaction lands). Checked live against the
   * rail each call (`pending-payment-status.ts`), not read off `booking`
   * directly — the trail itself doesn't record a leg as done until *every*
   * applicable leg is done, so a booking can genuinely have "the deposit is
   * captured on Razorpay's side" be true here before it's true in the trail.
   * Still read-only — no gate, no money moved, same contract this tool
   * always had.
   */
  pendingPayment:
    | {
        payUrl: string
        outstanding: readonly OutstandingPaymentLeg[]
        completed: readonly OutstandingPaymentLeg[]
      }
    | undefined
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
  // Migration 0011: a bookingId belonging to another merchant is "unknown,"
  // same treatment as a bookingId that never existed at all — see
  // tenant-guard.ts.
  const booking = ownedByMerchant(await deps.eventStore.loadSnapshot(cmd.bookingId), deps.merchantId)
  if (!booking) {
    throw new BookingNotFoundError(`unknown booking: ${cmd.bookingId}`)
  }

  const statuses = await checkAllPendingLegs(deps, booking.pendingPaymentLegs, booking.bookingId, deps.clock.now())
  if (!statuses) {
    return { booking, pendingPayment: undefined }
  }

  const baseUrl = deps.payPageBaseUrl ?? 'http://localhost:4002'
  const toLeg = (s: (typeof statuses)[number]): OutstandingPaymentLeg => ({ leg: s.leg, label: s.label, amountPaise: s.amountPaise })

  return {
    booking,
    pendingPayment: {
      payUrl: `${baseUrl}/pay/${booking.bookingId}`,
      outstanding: statuses.filter((s) => !s.done).map(toLeg),
      completed: statuses.filter((s) => s.done).map(toLeg),
    },
  }
}
