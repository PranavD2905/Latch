import { ulid } from 'ulid'
import { toPaise } from '../../domain/money.js'
import {
  PaymentDeclinedError,
  PaymentTimeoutError,
  type CaptureDepositParams,
  type CaptureDepositResult,
  type PaymentProvider,
  type PaymentStatus,
  type RefundDepositParams,
  type RefundDepositResult,
} from '../../ports/payment-provider.js'

export type PaymentScenario = 'success' | 'decline' | 'timeout'

/**
 * docs/02-tech-stack.md §13 / prompts/slice-1.md: must be able to simulate
 * success, decline, and timeout — scenarios that are hard to trigger
 * reliably against a live Razorpay sandbox but must be proven to work.
 * Tests call `setScenario` for a given idempotency key before invoking the
 * command handler, so behaviour is deterministic rather than random. (The
 * no-show authorisation leg's own scenarios — including the amount-mismatch
 * ceiling refusal — live on `FakePaymentRail`, not here; see dev-logs/005:
 * the old mandate-ceiling design this used to simulate was replaced by card
 * manual capture before it was ever exercised for real.)
 *
 * Idempotency is honoured here too, at the provider level: a repeated
 * `captureDeposit` call with a key that already succeeded returns the same
 * result rather than "charging" again — mirroring what the real Razorpay
 * Orders API does with a client-supplied receipt/idempotency key.
 */
export class FakePaymentProvider implements PaymentProvider {
  private readonly scenarios = new Map<string, PaymentScenario>()
  private readonly captured = new Map<string, CaptureDepositResult>()
  private readonly refunded = new Map<string, RefundDepositResult>()
  /** dev-logs/014: mirrors what a real Razorpay lookup would report for a paymentId, kept in sync by captureDeposit/refundDeposit. */
  private readonly statusByPaymentId = new Map<string, PaymentStatus>()

  setScenario(idempotencyKey: string, scenario: PaymentScenario): void {
    this.scenarios.set(idempotencyKey, scenario)
  }

  async captureDeposit(params: CaptureDepositParams): Promise<CaptureDepositResult> {
    const existing = this.captured.get(params.idempotencyKey)
    if (existing) {
      return existing
    }

    const scenario = this.scenarios.get(params.idempotencyKey) ?? 'success'
    switch (scenario) {
      case 'decline':
        throw new PaymentDeclinedError(params.reference)
      case 'timeout':
        throw new PaymentTimeoutError(params.reference)
      case 'success': {
        const result: CaptureDepositResult = { paymentId: `pay_${ulid()}`, amountPaise: params.amountPaise, instrument: 'upi' }
        this.captured.set(params.idempotencyKey, result)
        this.statusByPaymentId.set(result.paymentId, { status: 'captured', amountPaise: result.amountPaise })
        return result
      }
    }
  }

  async refundDeposit(params: RefundDepositParams): Promise<RefundDepositResult> {
    const existing = this.refunded.get(params.idempotencyKey)
    if (existing) {
      return existing
    }

    const result: RefundDepositResult = { refundId: `rfnd_${ulid()}`, amountPaise: params.amountPaise }
    this.refunded.set(params.idempotencyKey, result)
    this.statusByPaymentId.set(params.paymentId, { status: 'refunded', amountPaise: params.amountPaise })
    return result
  }

  async fetchPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    return this.statusByPaymentId.get(paymentId) ?? { status: 'unknown', amountPaise: toPaise(0) }
  }
}
