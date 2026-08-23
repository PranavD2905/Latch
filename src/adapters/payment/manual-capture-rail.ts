import Razorpay from 'razorpay'
import { toPaise } from '../../domain/money.js'
import {
  AuthorizationNotFoundError,
  CaptureAmountMismatchError,
  PaymentRailError,
  type AuthorizeParams,
  type AuthorizeResult,
  type CaptureAuthorizationParams,
  type CaptureAuthorizationResult,
  type PaymentRail,
} from '../../ports/payment-rail.js'
import { DEFAULT_CAPTURE_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS, receiptFor, sleep, toInstrument, type RazorpayPaymentLike } from './razorpay-shared.js'

export interface ManualCaptureRailOptions {
  keyId: string
  keySecret: string
  /** Same shape as `RazorpayPaymentProviderOptions` — see dev-logs/006/007 for why authorising still needs a human at Checkout. */
  authorizeTimeoutMs?: number
  authorizePollIntervalMs?: number
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
 * server-side, so `authorize()` creates an order with manual capture and
 * waits for a human to complete Checkout against it, exactly like
 * `captureDeposit`. The two payment objects at `confirm_with_deposit`
 * (deposit + authorisation) are therefore two separate Checkout completions
 * in this build — an honest consequence of the account-permission gate
 * dev-logs/006/007 already documented, not a new one.
 */
export class ManualCaptureRail implements PaymentRail {
  readonly name = 'manual_capture' as const
  private readonly client: Razorpay
  private readonly authorizeTimeoutMs: number
  private readonly authorizePollIntervalMs: number

  constructor(options: ManualCaptureRailOptions) {
    this.client = new Razorpay({ key_id: options.keyId, key_secret: options.keySecret })
    this.authorizeTimeoutMs = options.authorizeTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS
    this.authorizePollIntervalMs = options.authorizePollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  async authorize(params: AuthorizeParams): Promise<AuthorizeResult> {
    const receipt = receiptFor(params.idempotencyKey)

    let order
    try {
      order = await this.findOrder(receipt)
      if (!order) {
        order = await this.client.orders.create({
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
        })
      }
    } catch (err) {
      throw new PaymentRailError(params.reference, err)
    }

    const deadline = Date.now() + this.authorizeTimeoutMs
    for (;;) {
      let payment: RazorpayPaymentLike | undefined
      try {
        payment = await this.latestPaymentFor(order.id)
      } catch (err) {
        throw new PaymentRailError(params.reference, err)
      }

      if (payment?.status === 'authorized') {
        return {
          authorizationId: payment.id,
          amountPaise: toPaise(Number(payment.amount)),
          expiresAt: new Date(params.now.getTime() + MAX_MANUAL_EXPIRY_MINUTES * 60_000),
        }
      }
      if (payment?.status === 'failed') {
        throw new PaymentRailError(params.reference, new Error(`authorization attempt failed for ${params.reference}`))
      }
      if (Date.now() >= deadline) {
        throw new PaymentRailError(params.reference, new Error(`no authorization landed for ${params.reference} within ${this.authorizeTimeoutMs}ms`))
      }
      await sleep(this.authorizePollIntervalMs)
    }
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
      throw new PaymentRailError(params.reference, err)
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
 * Razorpay's SDK throws `{ statusCode, error: { code, description } }` as a
 * plain object, not an `Error` instance (`node_modules/razorpay/dist/api.js`,
 * `normalizeError`). Item 7's ceiling-refusal demo depends on recognising
 * this specific rejection: "Capture amount must be equal to the amount
 * authorized" (dev-logs/005, verified against Razorpay's own docs).
 */
function razorpayErrorDescription(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'error' in err) {
    const inner = (err as { error?: unknown }).error
    if (inner && typeof inner === 'object' && 'description' in inner) {
      return String((inner as { description: unknown }).description)
    }
  }
  return undefined
}

function isCaptureAmountMismatch(err: unknown): boolean {
  return (razorpayErrorDescription(err) ?? '').toLowerCase().includes('capture amount must be equal')
}

function isAuthorizationNotFound(err: unknown): boolean {
  const description = (razorpayErrorDescription(err) ?? '').toLowerCase()
  return description.includes('does not exist') || description.includes('not found')
}
