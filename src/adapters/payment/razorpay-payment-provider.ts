import Razorpay from 'razorpay'
import { toPaise } from '../../domain/money.js'
import {
  PaymentDeclinedError,
  PaymentProviderError,
  PaymentTimeoutError,
  type CaptureDepositParams,
  type CaptureDepositResult,
  type PaymentProvider,
  type PaymentStatus,
  type RefundDepositParams,
  type RefundDepositResult,
} from '../../ports/payment-provider.js'
import { DEFAULT_CAPTURE_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS, isNotFound, receiptFor, sleep, toInstrument, toPaymentStatusValue, type RazorpayPaymentLike } from './razorpay-shared.js'

export interface RazorpayPaymentProviderOptions {
  keyId: string
  keySecret: string
  /**
   * How long `captureDeposit` waits for a customer to complete Checkout
   * against a freshly created order before giving up with
   * `PaymentTimeoutError`. Production default is generous (Checkout
   * sessions themselves run well under this); tests override it short to
   * prove the timeout path without actually waiting minutes. See
   * dev-logs/006 for why this polling shape exists at all — Razorpay has no
   * server-to-server way to *submit* a payment on a standard (non-TPV)
   * account, only to ask whether one has landed yet.
   */
  captureTimeoutMs?: number
  capturePollIntervalMs?: number
}

/**
 * Real Razorpay test-mode adapter for the `PaymentProvider` port
 * (docs/02-tech-stack.md §13). See dev-logs/006 for the constraints that
 * shaped this: a standard test-mode account has no server-to-server way to
 * submit a card or UPI payment (both the S2S JSON and UPI-collect create
 * endpoints 404 — verified live; Razorpay's own docs confirm both require
 * contacting support to enable TPV, the same activation-gating dev-logs/005
 * already rejected Reserve Pay over). The only way a payment gets attached
 * to an order is a customer completing Checkout. `captureDeposit` therefore
 * creates the order, then polls for a payment to land against it, rather
 * than submitting one itself.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  private readonly client: Razorpay
  private readonly captureTimeoutMs: number
  private readonly capturePollIntervalMs: number

  constructor(options: RazorpayPaymentProviderOptions) {
    this.client = new Razorpay({ key_id: options.keyId, key_secret: options.keySecret })
    this.captureTimeoutMs = options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS
    this.capturePollIntervalMs = options.capturePollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  async captureDeposit(params: CaptureDepositParams): Promise<CaptureDepositResult> {
    const receipt = receiptFor(params.idempotencyKey)

    let order
    try {
      order = await this.findOrder(receipt)
      if (!order) {
        order = await this.client.orders.create({
          amount: params.amountPaise,
          currency: 'INR',
          receipt,
          payment_capture: true,
          // dev-logs/014: the webhook handler correlates an incoming
          // `payment.captured`/`payment.failed` event back to a bookingId by
          // fetching the order these notes are attached to — Razorpay's own
          // `notes` object round-trips verbatim, unlike a payment method
          // string, which is why this is read from the order rather than
          // guessed from the payment entity.
          notes: { bookingId: params.reference },
        })
      }
    } catch (err) {
      throw new PaymentProviderError(params.reference, err)
    }

    const deadline = Date.now() + this.captureTimeoutMs
    for (;;) {
      let payment: RazorpayPaymentLike | undefined
      try {
        payment = await this.latestPaymentFor(order.id)
      } catch (err) {
        throw new PaymentProviderError(params.reference, err)
      }

      if (payment?.status === 'captured') {
        return {
          paymentId: payment.id,
          amountPaise: toPaise(Number(payment.amount)),
          instrument: toInstrument(payment.method, (message) => {
            throw new PaymentProviderError(params.reference, new Error(message))
          }),
        }
      }
      if (payment?.status === 'failed') {
        throw new PaymentDeclinedError(params.reference)
      }
      if (Date.now() >= deadline) {
        throw new PaymentTimeoutError(params.reference)
      }
      await sleep(this.capturePollIntervalMs)
    }
  }

  async refundDeposit(params: RefundDepositParams): Promise<RefundDepositResult> {
    const receipt = receiptFor(params.idempotencyKey)

    try {
      const existing = await this.findRefund(params.paymentId, receipt)
      if (existing) {
        return { refundId: existing.id, amountPaise: toPaise(Number(existing.amount)) }
      }

      const refund = await this.client.payments.refund(params.paymentId, {
        amount: params.amountPaise,
        receipt,
      })
      return { refundId: refund.id, amountPaise: toPaise(Number(refund.amount ?? params.amountPaise)) }
    } catch (err) {
      throw new PaymentProviderError(params.reference, err)
    }
  }

  /**
   * dev-logs/014 — the reconciliation worker's read. No side effect: a plain
   * fetch of whatever Razorpay's own record currently says, independent of
   * what `DEPOSIT_CAPTURED` in the trail claims. `'unknown'` covers a
   * paymentId Razorpay genuinely cannot resolve (not itself a mismatch —
   * the caller decides what that means).
   */
  async fetchPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    try {
      const payment = await this.client.payments.fetch(paymentId)
      return { status: toPaymentStatusValue(payment.status), amountPaise: toPaise(Number(payment.amount)) }
    } catch (err) {
      if (isNotFound(err)) return { status: 'unknown', amountPaise: toPaise(0) }
      throw new PaymentProviderError(paymentId, err)
    }
  }

  private async findOrder(receipt: string) {
    const result = await this.client.orders.all({ receipt, count: 1 })
    return result.items[0]
  }

  private async latestPaymentFor(orderId: string): Promise<RazorpayPaymentLike | undefined> {
    const result = await this.client.orders.fetchPayments(orderId)
    return result.items[result.items.length - 1]
  }

  private async findRefund(paymentId: string, receipt: string) {
    const result = await this.client.payments.fetchMultipleRefund(paymentId)
    return result.items.find((r) => r.receipt === receipt)
  }
}
