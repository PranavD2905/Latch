import { ulid } from 'ulid'
import { toPaise } from '../../domain/money.js'
import {
  PaymentDeclinedError,
  type CaptureDepositParams,
  type CaptureDepositResult,
  type DepositOrder,
  type PaymentProvider,
  type PaymentStatus,
  type RefundDepositParams,
  type RefundDepositResult,
} from '../../ports/payment-provider.js'

export type PaymentScenario = 'success' | 'decline' | 'pending'

/**
 * docs/02-tech-stack.md §13 / prompts/slice-1.md: must be able to simulate
 * success, decline, and "nobody has paid the link yet" — scenarios that are
 * hard to trigger reliably against a live Razorpay sandbox but must be
 * proven to work. Tests call `setScenario` for a given idempotency key
 * before invoking the command handler, so behaviour is deterministic rather
 * than random. (The no-show authorisation leg's own scenarios — including
 * the amount-mismatch ceiling refusal — live on `FakePaymentRail`, not here;
 * see dev-logs/005: the old mandate-ceiling design this used to simulate was
 * replaced by card manual capture before it was ever exercised for real.)
 *
 * `'pending'` replaces the old `'timeout'` scenario (payment-link feature,
 * dev-logs entry for this slice): `pollDepositCapture` never throws a
 * timeout any more — "not paid yet" is the expected common case, not a
 * failure — so the fake mirrors that by returning `undefined` for as long as
 * the scenario stays `'pending'`. `completeDeposit` flips it to `'success'`,
 * modelling a human completing Checkout on a link issued by an earlier call
 * — the fake-backed twin of what a live retry against the real Razorpay
 * adapter observes once the human actually pays.
 *
 * Idempotency is honoured here too, at the provider level: a repeated
 * `pollDepositCapture` call with a key that already succeeded returns the
 * same result rather than "charging" again — mirroring what the real
 * Razorpay Orders API does with a client-supplied receipt/idempotency key.
 */
export class FakePaymentProvider implements PaymentProvider {
  private readonly scenarios = new Map<string, PaymentScenario>()
  private readonly orders = new Map<string, DepositOrder>()
  /** Reverse of `orders` — `pollDepositCapture` only receives the order, not the idempotencyKey, mirroring the real adapter's shape (dev-logs entry, payment-link feature). */
  private readonly idempotencyKeyByOrderId = new Map<string, string>()
  private readonly captured = new Map<string, CaptureDepositResult>()
  private readonly refunded = new Map<string, RefundDepositResult>()
  /** dev-logs/014: mirrors what a real Razorpay lookup would report for a paymentId, kept in sync by pollDepositCapture/refundDeposit. */
  private readonly statusByPaymentId = new Map<string, PaymentStatus>()

  setScenario(idempotencyKey: string, scenario: PaymentScenario): void {
    this.scenarios.set(idempotencyKey, scenario)
  }

  /** Test helper: models a human completing Checkout on a link a `'pending'` scenario already issued. */
  completeDeposit(idempotencyKey: string): void {
    this.scenarios.set(idempotencyKey, 'success')
  }

  async ensureDepositOrder(params: CaptureDepositParams): Promise<DepositOrder> {
    const existing = this.orders.get(params.idempotencyKey)
    if (existing) return existing
    const order: DepositOrder = { orderId: `order_${ulid()}`, amountPaise: params.amountPaise }
    this.orders.set(params.idempotencyKey, order)
    this.idempotencyKeyByOrderId.set(order.orderId, params.idempotencyKey)
    return order
  }

  /** `options` is accepted for shape-parity with the port/real adapter but ignored — the fake resolves synchronously, so there's no timeout to bound. */
  async pollDepositCapture(order: DepositOrder, reference: string, _options?: { timeoutMs?: number }): Promise<CaptureDepositResult | undefined> {
    const idempotencyKey = this.idempotencyKeyByOrderId.get(order.orderId)
    if (!idempotencyKey) throw new Error(`pollDepositCapture called with an order this fake never created: ${order.orderId}`)

    const existing = this.captured.get(idempotencyKey)
    if (existing) {
      return existing
    }

    const scenario = this.scenarios.get(idempotencyKey) ?? 'success'
    switch (scenario) {
      case 'decline':
        throw new PaymentDeclinedError(reference)
      case 'pending':
        return undefined
      case 'success': {
        const result: CaptureDepositResult = { paymentId: `pay_${ulid()}`, amountPaise: order.amountPaise, instrument: 'upi' }
        this.captured.set(idempotencyKey, result)
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
