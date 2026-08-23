import { createHash } from 'node:crypto'
import type { Instrument } from '../../domain/events.js'

export const DEFAULT_CAPTURE_TIMEOUT_MS = 5 * 60 * 1000
export const DEFAULT_POLL_INTERVAL_MS = 3000

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Razorpay's Orders API has no native idempotency mechanism (verified —
 * dev-logs/006: a repeated `receipt` value creates a second, distinct
 * order). `receipt` is, however, queryable, so lookup-before-create against
 * it is the mechanism this adapter uses instead — for orders, refunds, and
 * (Slice 4) no-show authorisation orders alike. `receipt` is capped at 40
 * characters by Razorpay, so an idempotency key outside that (or containing
 * characters Razorpay might reject) is hashed down to a fixed-length, safe
 * value; a key that already fits is passed through unchanged so hand-picked
 * test fixtures stay legible in the dashboard.
 */
export function receiptFor(idempotencyKey: string): string {
  if (/^[A-Za-z0-9_-]{1,40}$/.test(idempotencyKey)) {
    return idempotencyKey
  }
  return `lh_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 37)}`
}

export interface RazorpayPaymentLike {
  id: string
  status: string
  amount: number | string
  method: string
}

/**
 * Razorpay's `payment.method` is a free-form string; our `Instrument` union
 * is closed (B1 needs a stable, known vocabulary on the trail). An
 * unrecognised method throws rather than silently mislabelling which
 * instrument moved the money. `onUnrecognised` lets each caller wrap the
 * error in its own port's error type (`PaymentProviderError` vs.
 * `PaymentRailError`).
 */
export function toInstrument(method: string, onUnrecognised: (message: string) => never): Instrument {
  switch (method) {
    case 'card':
    case 'upi':
    case 'netbanking':
    case 'wallet':
      return method
    default:
      onUnrecognised(`unrecognised Razorpay payment method: ${method}`)
  }
}
