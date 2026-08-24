import type { BookingEvent } from './types'

export interface RunningTotals {
  /** Deposits + no-show charges, net of refunds. Must land on ₹0 after a merchant decline — the demo's punchline. */
  netCustomerCostPaise: number
  /** What the merchant actually keeps: applied retentions plus no-show charges. */
  netMerchantRetentionPaise: number
  /** Sum, across every still-open authorisation, of ceiling minus whatever has been captured against it. */
  authorizationHeadroomPaise: number
}

/**
 * Computed from event *type*, not the raw `action.direction` field.
 * docs/03-domain-model.md §4's event catalogue names each money event's
 * direction relative to the merchant explicitly (`DEPOSIT_CAPTURED` "in",
 * `RETENTION_APPLIED` "kept", `REFUND_ISSUED` "out", `NO_SHOW_CHARGED`
 * "in") — that's the authoritative axis for a running total. `direction`
 * itself is rendered verbatim on each event card since it's part of the
 * actual recorded fact, but it isn't a safe input to sum across event types
 * for this purpose.
 */
export function computeTotals(events: readonly BookingEvent[]): RunningTotals {
  let netCustomerCostPaise = 0
  let netMerchantRetentionPaise = 0
  const headroomByBooking = new Map<string, number>()

  for (const event of events) {
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
  }

  const authorizationHeadroomPaise = [...headroomByBooking.values()].reduce((sum, v) => sum + v, 0)

  return { netCustomerCostPaise, netMerchantRetentionPaise, authorizationHeadroomPaise }
}
