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

export class PaymentTimeoutError extends Error {
  constructor(reference: string) {
    super(`Payment timed out for ${reference}`)
    this.name = 'PaymentTimeoutError'
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
  captureDeposit(params: CaptureDepositParams): Promise<CaptureDepositResult>
  refundDeposit(params: RefundDepositParams): Promise<RefundDepositResult>
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
