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
 * Distinct from PaymentDeclinedError/PaymentTimeoutError, which are expected
 * business outcomes `confirm_with_deposit` already knows how to handle (see
 * dev-logs/004). This is an unexpected failure talking to the rail itself —
 * bad credentials, a malformed request, a network fault, a rail-side bug.
 * Slice 2 added this once RazorpayPaymentProvider needed somewhere to put
 * errors that are neither "customer declined" nor "customer never paid in
 * time" — never leak the raw SDK error to a caller (slice-2.md), wrap it here
 * instead. See dev-logs/006.
 */
export class PaymentProviderError extends Error {
  constructor(reference: string, cause: unknown) {
    super(`Unexpected payment provider error for ${reference}: ${describeCause(cause)}`)
    this.name = 'PaymentProviderError'
    this.cause = cause
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (cause && typeof cause === 'object' && 'description' in cause) return String((cause as { description: unknown }).description)
  return String(cause)
}

/**
 * docs/02-tech-stack.md §13 / docs/01-architecture.md Idea 3: the mandate
 * ceiling is enforced by Razorpay, not by Latch. `FakePaymentProvider`
 * simulates that rejection so the bound can be demoed before Slice 4 wires
 * a real mandate. Not exercised by a captureDeposit call in Slice 1 (there is
 * no mandate yet) — the scenario exists on the fake now so Slice 4 does not
 * need to touch this port's shape.
 */
export class MandateCeilingExceededError extends Error {
  constructor(reference: string) {
    super(`Debit for ${reference} exceeds the registered mandate ceiling`)
    this.name = 'MandateCeilingExceededError'
  }
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
}
