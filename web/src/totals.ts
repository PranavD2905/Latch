import type { BookingEvent, BoundEnforcer } from './types'

export interface RunningTotals {
  /** Deposits + no-show charges, net of refunds. Must land on ₹0 after a merchant decline — the demo's punchline. */
  netCustomerCostPaise: number
  /** What the merchant actually keeps: applied retentions plus no-show charges. */
  netMerchantRetentionPaise: number
  /** Sum, across every still-open authorisation, of ceiling minus whatever has been captured against it. */
  authorizationHeadroomPaise: number
}

export interface RunningPoint extends RunningTotals {
  event: BookingEvent
  index: number
}

const EMPTY_TOTALS: RunningTotals = { netCustomerCostPaise: 0, netMerchantRetentionPaise: 0, authorizationHeadroomPaise: 0 }

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
  const headroomByBooking = new Map<string, number>()

  return events.map((event, index) => {
    switch (event.type) {
      case 'DEPOSIT_CAPTURED': {
        netCustomerCostPaise += event.action?.amountPaise ?? 0
        break
      }
      case 'REFUND_ISSUED': {
        netCustomerCostPaise -= event.action?.amountPaise ?? 0
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
        headroomByBooking.set(event.bookingId, event.bound?.headroomAfterPaise ?? 0)
        break
      }
      case 'AUTHORIZATION_HELD': {
        headroomByBooking.set(event.bookingId, (event['amountPaise'] as number | undefined) ?? 0)
        break
      }
      case 'AUTHORIZATION_RELEASED':
      case 'AUTHORIZATION_LAPSED': {
        headroomByBooking.delete(event.bookingId)
        break
      }
      default:
        break
    }

    const authorizationHeadroomPaise = [...headroomByBooking.values()].reduce((sum, v) => sum + v, 0)
    return { event, index, netCustomerCostPaise, netMerchantRetentionPaise, authorizationHeadroomPaise }
  })
}

export function computeTotals(events: readonly BookingEvent[]): RunningTotals {
  const series = computeRunningSeries(events)
  return series.length > 0 ? series[series.length - 1]! : EMPTY_TOTALS
}

export function countRefusals(events: readonly BookingEvent[]): number {
  return events.filter((e) => e.type === 'ACTION_REFUSED').length
}

/** Event counts grouped by `bound.enforcedBy` — the input to the enforcement-tier breakdown chart. `AUTHORIZATION_HELD` counts as `payment_rail` even though it's not a `MoneyFields` event (see `EnforcedByBadge` usage in `EventsTable`). */
export function countByEnforcement(events: readonly BookingEvent[]): Record<BoundEnforcer, number> {
  const counts: Record<BoundEnforcer, number> = { latch_policy: 0, db_constraint: 0, payment_rail: 0 }
  for (const event of events) {
    if (event.type === 'AUTHORIZATION_HELD') {
      counts.payment_rail += 1
    } else if (event.bound?.enforcedBy) {
      counts[event.bound.enforcedBy] += 1
    }
  }
  return counts
}
