import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Instrument } from '../../domain/events.js'
import type { PaymentStatusValue } from '../../ports/payment-provider.js'

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
 * dev-logs/014: Razorpay's `payment.status` is a free-form string with more
 * values than the reconciliation worker's vocabulary needs to distinguish
 * (`created`, `authorized`, `captured`, `refunded`, `failed`, plus others
 * this codebase never puts a payment into, like `pending`). Anything not in
 * that list maps to `'unknown'` rather than throwing — an unrecognised
 * status is itself exactly the kind of disagreement reconciliation exists to
 * surface, not a reason to crash the worker.
 */
export function toPaymentStatusValue(status: string): PaymentStatusValue {
  switch (status) {
    case 'created':
    case 'authorized':
    case 'captured':
    case 'refunded':
    case 'failed':
      return status
    default:
      return 'unknown'
  }
}

/**
 * Razorpay's SDK throws a plain `{ statusCode, error: { code, description } }`
 * object, not an `Error` (see `manual-capture-rail.ts`'s own note on this).
 * `statusCode` is `400` with a "such id does not exist" description when a
 * paymentId genuinely doesn't resolve — the reconciliation lookups treat
 * that as `'unknown'`, not a hard failure.
 */
export function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const description = 'error' in err && err.error && typeof err.error === 'object' && 'description' in err.error ? String((err.error as { description: unknown }).description) : ''
  return description.toLowerCase().includes('does not exist') || description.toLowerCase().includes('not found')
}

/**
 * dev-logs/014, item 2 — Razorpay's documented webhook signature scheme:
 * HMAC-SHA256 of the *raw* request body (not the re-serialised JSON — a
 * parse-then-stringify round trip is not guaranteed byte-identical, e.g. key
 * ordering/whitespace, and would silently break verification), hex-encoded,
 * against the webhook secret configured in the Dashboard (or via the
 * Webhooks API), compared against the `X-Razorpay-Signature` header.
 * Security-critical: this is the one thing standing between "an endpoint
 * that appends trail events on request" and a real forgery surface in a
 * money system — verified with a constant-time comparison
 * (`timingSafeEqual`) specifically so a timing side-channel can't be used to
 * guess the correct signature one byte at a time.
 */
export function verifyRazorpayWebhookSignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex')
  const expected = Buffer.from(expectedHex, 'utf8')
  const actual = Buffer.from(signatureHeader, 'utf8')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
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
