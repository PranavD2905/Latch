import { ulid } from 'ulid'
import { toPaise, type Paise } from '../../domain/money.js'
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
import { MAX_MANUAL_EXPIRY_MINUTES } from './manual-capture-rail.js'

export type AuthorizeScenario = 'success' | 'decline' | 'pending'

interface HeldAuthorization {
  amountPaise: Paise
  captured: boolean
}

/**
 * `PaymentRail`'s deterministic test double — mirrors `FakePaymentProvider`'s
 * shape (docs/02-tech-stack.md §13), including the `'pending'` scenario /
 * `completeAuthorization` test helper (payment-link feature, dev-logs entry
 * for this slice — see `FakePaymentProvider`'s own comment for the full
 * reasoning). `captureAuthorization` deliberately does *not* take a scenario
 * flag for the amount-mismatch case: it genuinely compares the requested
 * amount against what was authorised and throws `CaptureAmountMismatchError`
 * on any disagreement, exactly mirroring real Razorpay's own behaviour — the
 * item-7 ceiling-refusal demo works identically against this fake and
 * against `ManualCaptureRail`.
 */
export class FakePaymentRail implements PaymentRail {
  readonly name = 'manual_capture' as const
  private readonly scenarios = new Map<string, AuthorizeScenario>()
  private readonly orders = new Map<string, AuthorizationOrder>() // keyed by idempotencyKey
  /** Reverse of `orders` — `pollAuthorization` only receives the order, not the idempotencyKey, mirroring the real adapter's shape (dev-logs entry, payment-link feature). */
  private readonly idempotencyKeyByOrderId = new Map<string, string>()
  private readonly authorized = new Map<string, AuthorizeResult>() // keyed by idempotencyKey
  private readonly held = new Map<string, HeldAuthorization>() // keyed by authorizationId

  setScenario(idempotencyKey: string, scenario: AuthorizeScenario): void {
    this.scenarios.set(idempotencyKey, scenario)
  }

  /** Test helper: models a human completing Checkout on a link a `'pending'` scenario already issued. */
  completeAuthorization(idempotencyKey: string): void {
    this.scenarios.set(idempotencyKey, 'success')
  }

  async ensureAuthorizationOrder(params: AuthorizeParams): Promise<AuthorizationOrder> {
    const existing = this.orders.get(params.idempotencyKey)
    if (existing) return existing
    const order: AuthorizationOrder = { orderId: `order_${ulid()}`, amountPaise: params.amountPaise }
    this.orders.set(params.idempotencyKey, order)
    this.idempotencyKeyByOrderId.set(order.orderId, params.idempotencyKey)
    return order
  }

  /** `options` is accepted for shape-parity with the port/real adapter but ignored — the fake resolves synchronously, so there's no timeout to bound. */
  async pollAuthorization(order: AuthorizationOrder, reference: string, now: Date, _options?: { timeoutMs?: number }): Promise<AuthorizeResult | undefined> {
    const idempotencyKey = this.idempotencyKeyByOrderId.get(order.orderId)
    if (!idempotencyKey) throw new Error(`pollAuthorization called with an order this fake never created: ${order.orderId}`)

    const existing = this.authorized.get(idempotencyKey)
    if (existing) {
      return existing
    }

    const scenario = this.scenarios.get(idempotencyKey) ?? 'success'
    if (scenario === 'decline') {
      throw new PaymentRailError(reference, new Error('authorization declined (fake scenario)'))
    }
    if (scenario === 'pending') {
      return undefined
    }

    const authorizationId = `pay_${ulid()}`
    const result: AuthorizeResult = {
      authorizationId,
      amountPaise: order.amountPaise,
      expiresAt: new Date(now.getTime() + MAX_MANUAL_EXPIRY_MINUTES * 60_000),
    }
    this.authorized.set(idempotencyKey, result)
    this.held.set(authorizationId, { amountPaise: order.amountPaise, captured: false })
    return result
  }

  async captureAuthorization(params: CaptureAuthorizationParams): Promise<CaptureAuthorizationResult> {
    const heldAuth = this.held.get(params.authorizationId)
    if (!heldAuth) {
      throw new AuthorizationNotFoundError(params.authorizationId)
    }
    if (heldAuth.captured) {
      return { paymentId: params.authorizationId, amountPaise: heldAuth.amountPaise, instrument: 'card' }
    }
    if (toPaise(params.amountPaise) !== heldAuth.amountPaise) {
      throw new CaptureAmountMismatchError(params.reference, params.amountPaise)
    }
    heldAuth.captured = true
    return { paymentId: params.authorizationId, amountPaise: heldAuth.amountPaise, instrument: 'card' }
  }

  async fetchAuthorizationStatus(authorizationId: string): Promise<AuthorizationStatus> {
    const heldAuth = this.held.get(authorizationId)
    if (!heldAuth) return { status: 'unknown', amountPaise: toPaise(0) }
    return { status: heldAuth.captured ? 'captured' : 'authorized', amountPaise: heldAuth.amountPaise }
  }
}
