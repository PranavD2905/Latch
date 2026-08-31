import Razorpay from 'razorpay'
import { toPaise } from '../../domain/money.js'
import {
  PaymentDeclinedError,
  PaymentProviderError,
  type CaptureDepositParams,
  type CaptureDepositResult,
  type DepositOrder,
  type PaymentProvider,
  type PaymentStatus,
  type RefundDepositParams,
  type RefundDepositResult,
} from '../../ports/payment-provider.js'
import { instrumentRazorpayClient } from '../observability/metrics.js'
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_QUICK_POLL_TIMEOUT_MS, isNotFound, parseRazorpaySdkError, receiptFor, sleep, toInstrument, toPaymentStatusValue, type RazorpayPaymentLike } from './razorpay-shared.js'

export interface RazorpayPaymentProviderOptions {
  keyId: string
  keySecret: string
}

/** Required by Razorpay's UPI collect endpoint but not meaningful for a VPA-only test payer — see `payDepositViaUpiCollect`. */
const S2S_PLACEHOLDER_EMAIL = 'payer@latch.test'
const S2S_PLACEHOLDER_CONTACT = '9999999999'

/**
 * Real Razorpay test-mode adapter for the `PaymentProvider` port
 * (docs/02-tech-stack.md §13). See dev-logs/006 for the constraints that
 * shaped this: a standard test-mode account has no server-to-server way to
 * submit a card or UPI payment (both the S2S JSON and UPI-collect create
 * endpoints 404 — verified live; Razorpay's own docs confirm both require
 * contacting support to enable TPV, the same activation-gating dev-logs/005
 * already rejected Reserve Pay over). The only way a payment gets attached
 * to an order is a customer completing Checkout — `ensureDepositOrder`
 * creates the order (or finds it, by receipt, if this idempotency key
 * already has one) and `pollDepositCapture` checks whether a payment has
 * landed against it, rather than submitting one itself. Payment-link feature
 * (dev-logs entry for this slice): this used to be one long-blocking
 * create-then-poll-for-five-minutes call (`captureDeposit`) — split so
 * `confirm_with_deposit` can hand back a payable link the instant the order
 * exists, instead of blocking with nothing to show a human.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  private readonly client: Razorpay

  constructor(options: RazorpayPaymentProviderOptions) {
    this.client = instrumentRazorpayClient(new Razorpay({ key_id: options.keyId, key_secret: options.keySecret }))
  }

  async ensureDepositOrder(params: CaptureDepositParams): Promise<DepositOrder> {
    const receipt = receiptFor(params.idempotencyKey)
    try {
      const order =
        (await this.findOrder(receipt)) ??
        (await this.client.orders.create({
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
        }))
      return { orderId: order.id, amountPaise: toPaise(Number(order.amount)) }
    } catch (err) {
      throw new PaymentProviderError(params.reference, err, parseRazorpaySdkError(err))
    }
  }

  async pollDepositCapture(order: DepositOrder, reference: string, options?: { timeoutMs?: number }): Promise<CaptureDepositResult | undefined> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_QUICK_POLL_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs

    for (;;) {
      let payment: RazorpayPaymentLike | undefined
      try {
        payment = await this.latestPaymentFor(order.orderId)
      } catch (err) {
        throw new PaymentProviderError(reference, err, parseRazorpaySdkError(err))
      }

      if (payment?.status === 'captured') {
        return {
          paymentId: payment.id,
          amountPaise: toPaise(Number(payment.amount)),
          instrument: toInstrument(payment.method, (message) => {
            throw new PaymentProviderError(reference, new Error(message))
          }),
        }
      }
      if (payment?.status === 'failed') {
        throw new PaymentDeclinedError(reference)
      }
      if (Date.now() >= deadline) {
        return undefined
      }
      await sleep(DEFAULT_POLL_INTERVAL_MS)
    }
  }

  /**
   * See the port's own doc comment for why this exists and what it doesn't
   * cover. `email`/`contact` are fixed placeholder values, not collected on
   * the pay page — Razorpay's collect endpoint requires both, but neither is
   * meaningful for a test-mode payer identified only by a VPA.
   */
  async payDepositViaUpiCollect(order: DepositOrder, vpa: string, reference: string, options?: { timeoutMs?: number }): Promise<CaptureDepositResult | undefined> {
    try {
      // The SDK's own declared type for this call (`RazorpayPaymentUpiCreateRequestBody`)
      // expects a nested `upi: { vpa }` shape and requires `ip`/`referer`/`user_agent` —
      // verified live against this account that `/payments/create/upi` actually accepts
      // (and needs) a flat top-level `vpa`, and rejects nothing else this adapter omits.
      // `createUpi` forwards its argument straight through to the HTTP call (no
      // transformation in the SDK itself), so the cast below is to the type the SDK
      // declares, not to what the wire actually wants.
      await this.client.payments.createUpi({
        amount: order.amountPaise,
        currency: 'INR',
        order_id: order.orderId,
        email: S2S_PLACEHOLDER_EMAIL,
        contact: S2S_PLACEHOLDER_CONTACT,
        method: 'upi',
        vpa,
      } as unknown as Parameters<Razorpay['payments']['createUpi']>[0])
    } catch (err) {
      throw new PaymentProviderError(reference, err, parseRazorpaySdkError(err))
    }
    return this.pollDepositCapture(order, reference, options)
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
      throw new PaymentProviderError(params.reference, err, parseRazorpaySdkError(err))
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
      throw new PaymentProviderError(paymentId, err, parseRazorpaySdkError(err))
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
