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
}
