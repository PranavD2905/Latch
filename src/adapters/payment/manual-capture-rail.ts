import Razorpay from 'razorpay'
import { toPaise } from '../../domain/money.js'
import {
  AuthorizationNotFoundError,
  CaptureAmountMismatchError,
  PaymentRailError,
  type AuthorizationOrder,
  type AuthorizationStatus,
  type AuthorizeParams,
  type AuthorizeResult,
  type CaptureAuthorizationParams,
  type CaptureAuthorizationResult,
  type PaymentRail,
} from '../../ports/payment-rail.js'
import { instrumentRazorpayClient } from '../observability/metrics.js'
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_QUICK_POLL_TIMEOUT_MS,
  isNotFound,
  parseRazorpaySdkError,
  receiptFor,
  sleep,
  submitUpiCollect,
  toInstrument,
  toPaymentStatusValue,
  type RazorpayPaymentLike,
} from './razorpay-shared.js'

export interface ManualCaptureRailOptions {
  keyId: string
  keySecret: string
}

/** dev-logs/005 constraint 3: `manual_expiry_period` maxes at 7200 minutes (5 days) — not a default we chose, a ceiling Razorpay enforces. */
export const MAX_MANUAL_EXPIRY_MINUTES = 7200

/**
 * The `PaymentRail` port's built, active implementation — the test-mode
 * stand-in for the no-show authorisation leg (dev-logs/005). `ReservePayRail`
 * is this port's other, unbuilt implementation; swapping which one
 * `stdio.ts`/`http.ts` construct is the entire migration path to the
 * production rail (docs/01-architecture.md Idea 3).
 *
 * Shares `RazorpayPaymentProvider`'s create-order-then-poll shape
 * (dev-logs/006/007): a standard test account cannot submit a payment
 * server-side, so `ensureAuthorizationOrder` creates an order with manual
 * capture and `pollAuthorization` checks whether a human has completed
 * Checkout against it, exactly like the deposit leg. The two (or three,
 * counting the session-complete mandate) payment objects at
 * `confirm_with_deposit` are therefore separate Checkout completions in this
 * build — an honest consequence of the account-permission gate
 * dev-logs/006/007 already documented, not a new one. Payment-link feature
 * (dev-logs entry for this slice): `authorize()` used to be one
 * long-blocking create-then-poll-for-five-minutes call — split for the same
 * reason `RazorpayPaymentProvider`'s was.
 */
export class ManualCaptureRail implements PaymentRail {
  readonly name = 'manual_capture' as const
  private readonly client: Razorpay

  constructor(options: ManualCaptureRailOptions) {
    this.client = instrumentRazorpayClient(new Razorpay({ key_id: options.keyId, key_secret: options.keySecret }))
  }

  async ensureAuthorizationOrder(params: AuthorizeParams): Promise<AuthorizationOrder> {
    const receipt = receiptFor(params.idempotencyKey)
    try {
      const order =
        (await this.findOrder(receipt)) ??
        (await this.client.orders.create({
          amount: params.amountPaise,
          currency: 'INR',
          receipt,
          payment: {
            capture: 'manual',
            capture_options: {
              // Required by the SDK's type regardless of capture mode, but
              // meaningless here: Razorpay's docs say it applies "only if
              // the value of `capture` parameter is `automatic`." 12 is the
              // documented minimum.
              automatic_expiry_period: 12,
              manual_expiry_period: MAX_MANUAL_EXPIRY_MINUTES,
              refund_speed: 'normal',
            },
          },
          // dev-logs/014 — same reasoning as RazorpayPaymentProvider: the
          // webhook handler resolves a bookingId from these notes, by
          // fetching the order a `payment.authorized`/`payment.captured`
          // event's `order_id` points at.
          notes: { bookingId: params.reference },
        }))
      return { orderId: order.id, amountPaise: toPaise(Number(order.amount)) }
    } catch (err) {
      throw new PaymentRailError(params.reference, err, parseRazorpaySdkError(err))
    }
  }

  async pollAuthorization(order: AuthorizationOrder, reference: string, now: Date, options?: { timeoutMs?: number }): Promise<AuthorizeResult | undefined> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_QUICK_POLL_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs

    for (;;) {
      let payment: RazorpayPaymentLike | undefined
      try {
        payment = await this.latestPaymentFor(order.orderId)
      } catch (err) {
        throw new PaymentRailError(reference, err, parseRazorpaySdkError(err))
      }

      if (payment?.status === 'authorized') {
        return {
          authorizationId: payment.id,
          amountPaise: toPaise(Number(payment.amount)),
          expiresAt: new Date(now.getTime() + MAX_MANUAL_EXPIRY_MINUTES * 60_000),
        }
      }
      if (payment?.status === 'failed') {
        throw new PaymentRailError(reference, new Error(`authorization attempt failed for ${reference}`))
      }
      if (Date.now() >= deadline) {
        return undefined
      }
      await sleep(DEFAULT_POLL_INTERVAL_MS)
    }
  }

  /** See the port's own doc comment and `submitUpiCollect`'s (razorpay-shared.ts) for what this does and doesn't cover. */
  async authorizeViaUpiCollect(order: AuthorizationOrder, vpa: string, reference: string, now: Date, options?: { timeoutMs?: number }): Promise<AuthorizeResult | undefined> {
    try {
      await submitUpiCollect(this.client, order.orderId, order.amountPaise, vpa)
    } catch (err) {
      throw new PaymentRailError(reference, err, parseRazorpaySdkError(err))
    }
    return this.pollAuthorization(order, reference, now, options)
  }

  async captureAuthorization(params: CaptureAuthorizationParams): Promise<CaptureAuthorizationResult> {
    try {
      // Capture has no receipt/idempotency-key parameter on Razorpay's API
      // (unlike orders/refunds), so idempotency here comes from checking
      // state first: a payment already `captured` at the requested amount is
      // a safe replay, not a re-capture attempt Razorpay would reject.
      const existing = await this.client.payments.fetch(params.authorizationId)
      if (existing.status === 'captured' && Number(existing.amount) === params.amountPaise) {
        return { paymentId: existing.id, amountPaise: toPaise(Number(existing.amount)), instrument: toRailInstrument(existing.method, params.reference) }
      }

      const payment = await this.client.payments.capture(params.authorizationId, params.amountPaise, 'INR')
      return { paymentId: payment.id, amountPaise: toPaise(Number(payment.amount)), instrument: toRailInstrument(payment.method, params.reference) }
    } catch (err) {
      if (isCaptureAmountMismatch(err)) {
        throw new CaptureAmountMismatchError(params.reference, params.amountPaise)
      }
      if (isAuthorizationNotFound(err)) {
        throw new AuthorizationNotFoundError(params.authorizationId)
      }
      throw new PaymentRailError(params.reference, err, parseRazorpaySdkError(err))
    }
  }

  /** dev-logs/014 — the rail-side twin of `RazorpayPaymentProvider.fetchPaymentStatus`. Read-only, no side effect. */
  async fetchAuthorizationStatus(authorizationId: string): Promise<AuthorizationStatus> {
    try {
      const payment = await this.client.payments.fetch(authorizationId)
      return { status: toPaymentStatusValue(payment.status), amountPaise: toPaise(Number(payment.amount)) }
    } catch (err) {
      if (isNotFound(err)) return { status: 'unknown', amountPaise: toPaise(0) }
      throw new PaymentRailError(authorizationId, err, parseRazorpaySdkError(err))
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
}

function toRailInstrument(method: string, reference: string) {
  return toInstrument(method, (message) => {
    throw new PaymentRailError(reference, new Error(message))
  })
}

/**
 * Item 7's ceiling-refusal demo depends on recognising this specific
 * rejection: "Capture amount must be equal to the amount authorized"
 * (dev-logs/005, verified against Razorpay's own docs). `parseRazorpaySdkError`
 * (`razorpay-shared.ts`) does the shape-narrowing this used to duplicate
 * locally — dev-logs/019.
 */
function isCaptureAmountMismatch(err: unknown): boolean {
  return (parseRazorpaySdkError(err)?.description ?? '').toLowerCase().includes('capture amount must be equal')
}

function isAuthorizationNotFound(err: unknown): boolean {
  const description = (parseRazorpaySdkError(err)?.description ?? '').toLowerCase()
  return description.includes('does not exist') || description.includes('not found')
}
