import { ulid } from 'ulid'
import {
  MandateCeilingExceededError,
  PaymentDeclinedError,
  PaymentTimeoutError,
  type CaptureDepositParams,
  type CaptureDepositResult,
  type PaymentProvider,
} from '../../ports/payment-provider.js'

export type PaymentScenario = 'success' | 'decline' | 'timeout' | 'mandate_ceiling_exceeded'

/**
 * docs/02-tech-stack.md §13 / prompts/slice-1.md: must be able to simulate
 * success, decline, timeout, and (for Slice 4) a mandate ceiling rejection —
 * scenarios that are hard to trigger reliably against a live Razorpay
 * sandbox but must be proven to work. Tests call `setScenario` for a given
 * idempotency key before invoking the command handler, so behaviour is
 * deterministic rather than random.
 *
 * Idempotency is honoured here too, at the provider level: a repeated
 * `captureDeposit` call with a key that already succeeded returns the same
 * result rather than "charging" again — mirroring what the real Razorpay
 * Orders API does with a client-supplied receipt/idempotency key.
 */
export class FakePaymentProvider implements PaymentProvider {
  private readonly scenarios = new Map<string, PaymentScenario>()
  private readonly captured = new Map<string, CaptureDepositResult>()

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
      case 'mandate_ceiling_exceeded':
        throw new MandateCeilingExceededError(params.reference)
      case 'success': {
        const result: CaptureDepositResult = { paymentId: `pay_${ulid()}`, amountPaise: params.amountPaise }
        this.captured.set(params.idempotencyKey, result)
        return result
      }
    }
  }
}
