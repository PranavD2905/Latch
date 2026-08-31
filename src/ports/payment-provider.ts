import type { Instrument } from '../domain/events.js'
import type { Paise } from '../domain/money.js'

export interface CaptureDepositParams {
  amountPaise: Paise
  idempotencyKey: string
  /** What this charge is for, for the provider's own reference — the bookingId here. */
  reference: string
}

export interface CaptureDepositResult {
  paymentId: string
  amountPaise: Paise
  /**
   * Which instrument actually moved the money — feeds `DEPOSIT_CAPTURED`'s
   * `action.instrument` (B1: "which rupee moved"). Added in Slice 2:
   * `confirm-with-deposit.ts` previously hardcoded `'upi'` regardless of
   * what actually captured, which went stale the moment dev-logs/005 moved
   * the rail to card. The provider — the only thing that actually knows —
   * reports it instead. See dev-logs/006.
   */
  instrument: Instrument
}

/** The order a human can pay against — `ensureDepositOrder`'s result. */
export interface DepositOrder {
  orderId: string
  amountPaise: Paise
}

export interface RefundDepositParams {
  /** The `paymentId` a prior `captureDeposit` returned. */
  paymentId: string
  amountPaise: Paise
  idempotencyKey: string
  /** What this refund is for, for the provider's own reference — the bookingId here. */
  reference: string
}

export interface RefundDepositResult {
  refundId: string
  amountPaise: Paise
}

/**
 * dev-logs/014: the reconciliation worker's vocabulary for "what does
 * Razorpay's own record currently say", independent of what Latch's trail
 * believes. Deliberately not the same union as `MoneyDirection`/instrument —
 * this is a payment *lifecycle* status, the thing that can drift from the
 * trail, not the shape of a settled action.
 */
export type PaymentStatusValue = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed' | 'unknown'

export interface PaymentStatus {
  status: PaymentStatusValue
  amountPaise: Paise
}

export class PaymentDeclinedError extends Error {
  constructor(reference: string) {
    super(`Payment declined for ${reference}`)
    this.name = 'PaymentDeclinedError'
  }
}

/**
 * Optional, provider-agnostic detail an adapter can attach when it knows
 * more about `cause` than this port does — e.g. Razorpay's own `{ error:
 * { code, description } }` shape, parsed by `razorpay-shared.ts`'s
 * `parseRazorpaySdkError` and never imported here (this port must stay
 * implementable by any `PaymentProvider`, not just a Razorpay one).
 */
export interface PaymentProviderErrorDetails {
  code?: string | undefined
  description?: string | undefined
}

/**
 * Distinct from PaymentDeclinedError/PaymentTimeoutError, which are expected
 * business outcomes `confirm_with_deposit` already knows how to handle (see
 * dev-logs/004). This is an unexpected failure talking to the rail itself —
 * bad credentials, a malformed request, a network fault, a rail-side bug.
 * Slice 2 added this once RazorpayPaymentProvider needed somewhere to put
 * errors that are neither "customer declined" nor "customer never paid in
 * time" — never leak the raw SDK error to a caller (slice-2.md), wrap it here
 * instead. See dev-logs/006. `reference`/`providerErrorCode`/
 * `providerErrorDescription` are plain own properties (not just folded into
 * the message string) so a structured logger picks them up automatically
 * wherever this error is logged (Pino's `err` serializer copies an error's
 * own enumerable properties) — dev-logs/019. `reference` is a bookingId for
 * every throw site except `fetchPaymentStatus`'s, which passes the
 * `paymentId` it was looking up — named generically rather than `bookingId`
 * so it stays accurate at that one call site too.
 */
export class PaymentProviderError extends Error {
  readonly reference: string
  readonly providerErrorCode: string | undefined
  readonly providerErrorDescription: string | undefined

  constructor(reference: string, cause: unknown, details?: PaymentProviderErrorDetails) {
    super(`Unexpected payment provider error for ${reference}: ${describeCause(cause)}`)
    this.name = 'PaymentProviderError'
    this.cause = cause
    this.reference = reference
    this.providerErrorCode = details?.code
    this.providerErrorDescription = details?.description
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (cause && typeof cause === 'object' && 'description' in cause) return String((cause as { description: unknown }).description)
  return String(cause)
}

/**
 * Outbound port to the payment rail. docs/01-architecture.md system diagram:
 * `PaymentProvider -> Razorpay` in production, `-> FakeProvider` in tests.
 * The domain and app layers depend only on this interface — no Razorpay SDK
 * type crosses into either.
 */
export interface PaymentProvider {
  /**
   * Fast create-or-find, no waiting — the order a human needs to pay
   * against. Payment-link feature (dev-logs entry for this slice): what used
   * to be the first half of `captureDeposit`'s single long-blocking call,
   * pulled out so `confirm_with_deposit` can hand a payable link back
   * quickly instead of blocking with nothing to show for it. Idempotent by
   * the same receipt-lookup-before-create mechanism `captureDeposit` always
   * used (dev-logs/006) — calling this twice with the same `idempotencyKey`
   * finds the same order, never creates a second one.
   */
  ensureDepositOrder(params: CaptureDepositParams): Promise<DepositOrder>
  /**
   * Polls up to `timeoutMs` (short — a few seconds by default, meant to
   * catch a payer who was already mid-Checkout when this was called, not to
   * wait out a real Checkout) for the given order — an `ensureDepositOrder`
   * result the caller already holds — to show a captured payment. Takes the
   * order directly rather than re-deriving it from `CaptureDepositParams`
   * deliberately: a live test against real Razorpay found that calling
   * `ensureDepositOrder` twice in quick succession (once explicitly, once
   * again inside a naive `pollDepositCapture`) can create a *second* order
   * for the same receipt — Razorpay's receipt lookup is not immediately
   * consistent with a create that just happened milliseconds earlier. This
   * shape makes that duplicate-order class of bug structurally impossible:
   * there is no second lookup to race. Returns `undefined` — never throws a
   * timeout — when nothing has landed yet: "not paid yet" is the ordinary
   * case here, not a failure. Still throws `PaymentDeclinedError` for a
   * definite decline and `PaymentProviderError` for a rail fault. Safe to
   * call repeatedly with the same order (a later retry after the human
   * actually pays just observes the now-captured order).
   */
  pollDepositCapture(order: DepositOrder, reference: string, options?: { timeoutMs?: number }): Promise<CaptureDepositResult | undefined>
  refundDeposit(params: RefundDepositParams): Promise<RefundDepositResult>
  /**
   * S2S UPI collect — a payer's VPA goes straight from our own pay page to
   * Razorpay's server, no Checkout.js redirect. Only exists because this
   * account had TPV enabled for UPI collect (`/payments/create/upi`) after
   * dev-logs/006/029 were written; dev-logs/006 verified this same endpoint
   * 404ing, and dev-logs/029 carried forward "a human must complete
   * Checkout.js, and that can't be automated" as a standing limitation. Card
   * S2S (`/payments/create/json`) is still 404 on this account — re-verified
   * live before building this — so this exists for the deposit leg's UPI
   * path only; the authorisation legs stay on Checkout.js/card manual
   * capture (dev-logs/005's rail choice for those is untouched).
   *
   * Submits the collect request, then polls the same `order` this method was
   * given — reusing `pollDepositCapture`'s exact convergence loop rather than
   * a second one, for the same reason `pollDepositCapture` itself takes an
   * already-created `order` instead of re-deriving it (dev-logs/029's
   * duplicate-order bug). Returns `undefined` (not a throw) if the collect
   * request is still unresolved when the bounded poll gives up — Razorpay's
   * webhook will finalize it later exactly as it does for a Checkout.js
   * completion; "not resolved yet" is the ordinary case here, same as
   * `pollDepositCapture`. Throws `PaymentDeclinedError` for a definite
   * decline and `PaymentProviderError` for a rail fault (including a
   * malformed/rejected VPA at submission time).
   */
  payDepositViaUpiCollect(order: DepositOrder, vpa: string, reference: string, options?: { timeoutMs?: number }): Promise<CaptureDepositResult | undefined>
  /**
   * dev-logs/014: read-only, no side effect — asks Razorpay directly what a
   * previously-captured payment's status actually is *right now*, rather
   * than trusting that the trail's `DEPOSIT_CAPTURED` still matches reality.
   * The reconciliation worker's core primitive. `'unknown'` covers a
   * paymentId the provider genuinely cannot resolve (never treated as a
   * mismatch by itself — the caller decides what an unresolvable id means).
   */
  fetchPaymentStatus(paymentId: string): Promise<PaymentStatus>
}
