import type { BookingEvent, BoundEnforcer } from './types'
import { enforcerOf } from './types'

export interface RunningTotals {
  /** Deposits + no-show charges, net of refunds. Must land on ₹0 after a merchant decline — the demo's punchline. */
  netCustomerCostPaise: number
  /** What the merchant actually keeps: applied retentions plus no-show charges. */
  netMerchantRetentionPaise: number
  /** Sum, across every still-open authorisation, of ceiling minus whatever has been captured against it. */
  authorizationHeadroomPaise: number
  /**
   * dev-logs/014, item 5: docs/05-cost-model.md's "−₹7.08 sunk MDR" made
   * live rather than doc-only. Razorpay's platform fee (2% + 18% GST =
   * 2.36%, `RAZORPAY_MDR_RATE` below) is charged at capture and is *not*
   * reversed on a refund (docs/05-cost-model.md Part 2's own sourced quote)
   * — every `REFUND_ISSUED` event therefore represents a real, unrecoverable
   * cost to the merchant equal to 2.36% of whatever amount is being
   * refunded, on top of the ₹0 the customer nets. This is a number the
   * trail's own events don't carry directly (no event field says "MDR") —
   * it's derived here, from the same rate the cost model doc already
   * publishes, the same way the viewer already derives running totals from
   * event *type* rather than reading a pre-summed field.
   */
  sunkMdrPaise: number
}

export interface RunningPoint extends RunningTotals {
  event: BookingEvent
  index: number
}

/** docs/05-cost-model.md Part 2: 2% platform fee × 1.18 GST. ₹300 × this rate = ₹7.08, exactly the worked example. */
export const RAZORPAY_MDR_RATE = 0.0236

const EMPTY_TOTALS: RunningTotals = { netCustomerCostPaise: 0, netMerchantRetentionPaise: 0, authorizationHeadroomPaise: 0, sunkMdrPaise: 0 }

/**
 * Folds `events` (oldest first) into a running snapshot at every step —
 * the input to both the headline stat cards (the last point) and the
 * cumulative money-flow chart (every point). Computed from event *type*,
 * not the raw `action.direction` field: docs/03-domain-model.md §4's event
 * catalogue names each money event's direction relative to the merchant
 * explicitly (`DEPOSIT_CAPTURED` "in", `RETENTION_APPLIED` "kept",
 * `REFUND_ISSUED` "out", `NO_SHOW_CHARGED` "in") — that's the authoritative
 * axis for a running total. `direction` itself is rendered verbatim on each
 * event row since it's part of the actual recorded fact, but it isn't a
 * safe input to sum across event types for this purpose (see dev-logs/011).
 */
export function computeRunningSeries(events: readonly BookingEvent[]): RunningPoint[] {
  let netCustomerCostPaise = 0
  let netMerchantRetentionPaise = 0
  let sunkMdrPaise = 0
  const headroomByBooking = new Map<string, number>()

  return events.map((event, index) => {
    switch (event.type) {
      case 'DEPOSIT_CAPTURED': {
        netCustomerCostPaise += event.action?.amountPaise ?? 0
        break
      }
      case 'REFUND_ISSUED': {
        netCustomerCostPaise -= event.action?.amountPaise ?? 0
        // The fee charged at capture is never returned on refund (docs/05-
        // cost-model.md Part 2) — every refunded rupee carries this sunk
        // cost regardless of *why* it was refunded (customer cancellation
        // inside the free tier, or a merchant decline).
        sunkMdrPaise += Math.round((event.action?.amountPaise ?? 0) * RAZORPAY_MDR_RATE)
        break
      }
      case 'RETENTION_APPLIED': {
        netMerchantRetentionPaise += event.action?.amountPaise ?? 0
        break
      }
      case 'NO_SHOW_CHARGED': {
        const amount = event.action?.amountPaise ?? 0
        netCustomerCostPaise += amount
        netMerchantRetentionPaise += amount
        headroomByBooking.set(`${event.bookingId}:no_show`, event.bound?.headroomAfterPaise ?? 0)
        break
      }
      case 'SESSION_COMPLETE_CHARGED': {
        const amount = event.action?.amountPaise ?? 0
        netCustomerCostPaise += amount
        netMerchantRetentionPaise += amount
        headroomByBooking.set(`${event.bookingId}:session_complete`, event.bound?.headroomAfterPaise ?? 0)
        break
      }
      case 'AUTHORIZATION_HELD': {
        // Keyed per leg, not just per booking — a single booking can have
        // both a no-show ceiling and a session-complete mandate live at
        // once, and they must be summed independently rather than one
        // overwriting the other.
        headroomByBooking.set(`${event.bookingId}:no_show`, (event['amountPaise'] as number | undefined) ?? 0)
        break
      }
      case 'SESSION_COMPLETE_AUTHORIZATION_HELD': {
        headroomByBooking.set(`${event.bookingId}:session_complete`, (event['amountPaise'] as number | undefined) ?? 0)
        break
      }
      case 'AUTHORIZATION_RELEASED':
      case 'AUTHORIZATION_LAPSED': {
        headroomByBooking.delete(`${event.bookingId}:no_show`)
        break
      }
      case 'SESSION_COMPLETE_AUTHORIZATION_RELEASED':
      case 'SESSION_COMPLETE_AUTHORIZATION_LAPSED': {
        headroomByBooking.delete(`${event.bookingId}:session_complete`)
        break
      }
      default:
        break
    }

    const authorizationHeadroomPaise = [...headroomByBooking.values()].reduce((sum, v) => sum + v, 0)
    return { event, index, netCustomerCostPaise, netMerchantRetentionPaise, authorizationHeadroomPaise, sunkMdrPaise }
  })
}

export function computeTotals(events: readonly BookingEvent[]): RunningTotals {
  const series = computeRunningSeries(events)
  return series.length > 0 ? series[series.length - 1]! : EMPTY_TOTALS
}

export function countRefusals(events: readonly BookingEvent[]): number {
  return events.filter((e) => e.type === 'ACTION_REFUSED').length
}

/** Event counts per enforcement tier — the input to the breakdown chart. Attribution comes from `enforcerOf`, the same function the table badge and the filter use. */
export function countByEnforcement(events: readonly BookingEvent[]): Record<BoundEnforcer, number> {
  const counts: Record<BoundEnforcer, number> = { latch_policy: 0, db_constraint: 0, payment_rail: 0 }
  for (const event of events) {
    const enforcedBy = enforcerOf(event)
    if (enforcedBy) counts[enforcedBy] += 1
  }
  return counts
}
