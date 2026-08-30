import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Instrument } from '../../domain/events.js'
import type { PaymentStatusValue } from '../../ports/payment-provider.js'

export const DEFAULT_POLL_INTERVAL_MS = 3000
/**
 * Payment-link feature (dev-logs entry for this slice): `pollDepositCapture`/
 * `pollAuthorization` no longer block for minutes waiting on a human who
 * hasn't even seen the pay link yet — this is a quick check, meant to catch
 * a payer who was already mid-Checkout when `confirm_with_deposit` was
 * called (e.g. a retry after the human says "I've paid"), not to wait one
 * out. Two ticks at `DEFAULT_POLL_INTERVAL_MS` — long enough to absorb one
 * round trip to Razorpay without feeling broken, short enough that the
 * *common* case (nobody has clicked the link yet) returns promptly.
 */
export const DEFAULT_QUICK_POLL_TIMEOUT_MS = 2 * DEFAULT_POLL_INTERVAL_MS

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

export interface RazorpaySdkErrorDetails {
  code?: string | undefined
  description?: string | undefined
}

/**
 * Razorpay's SDK throws a plain `{ statusCode, error: { code, description } }`
 * object, not an `Error` (`node_modules/razorpay/dist/api.js`'s own
 * `normalizeError` — verified, not documented). Centralises the shape-
 * narrowing every call site here previously duplicated (`isNotFound` below,
 * `manual-capture-rail.ts`'s own former `razorpayErrorDescription`) into one
 * place — dev-logs/019, so `PaymentProviderError`/`PaymentRailError` can
 * attach `providerErrorCode`/`providerErrorDescription` as real structured
 * fields instead of only folding them into the message string.
 */
export function parseRazorpaySdkError(err: unknown): RazorpaySdkErrorDetails | undefined {
  if (!err || typeof err !== 'object' || !('error' in err)) return undefined
  const inner = (err as { error?: unknown }).error
  if (!inner || typeof inner !== 'object') return undefined
  const code = 'code' in inner ? String((inner as { code: unknown }).code) : undefined
  const description = 'description' in inner ? String((inner as { description: unknown }).description) : undefined
  return { code, description }
}

/**
 * `statusCode` is `400` with a "such id does not exist" description when a
 * paymentId genuinely doesn't resolve — the reconciliation lookups treat
 * that as `'unknown'`, not a hard failure.
 */
export function isNotFound(err: unknown): boolean {
  const description = (parseRazorpaySdkError(err)?.description ?? '').toLowerCase()
  return description.includes('does not exist') || description.includes('not found')
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
