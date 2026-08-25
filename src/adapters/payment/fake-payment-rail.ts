import { ulid } from 'ulid'
import { toPaise, type Paise } from '../../domain/money.js'
import {
  AuthorizationNotFoundError,
  CaptureAmountMismatchError,
  PaymentRailError,
  type AuthorizationStatus,
  type AuthorizeParams,
  type AuthorizeResult,
  type CaptureAuthorizationParams,
  type CaptureAuthorizationResult,
  type PaymentRail,
} from '../../ports/payment-rail.js'
import { MAX_MANUAL_EXPIRY_MINUTES } from './manual-capture-rail.js'

export type AuthorizeScenario = 'success' | 'decline' | 'timeout'

interface HeldAuthorization {
  amountPaise: Paise
  captured: boolean
}

/**
 * `PaymentRail`'s deterministic test double — mirrors `FakePaymentProvider`'s
 * shape (docs/02-tech-stack.md §13). `captureAuthorization` deliberately does
 * *not* take a scenario flag for the amount-mismatch case: it genuinely
 * compares the requested amount against what was authorised and throws
 * `CaptureAmountMismatchError` on any disagreement, exactly mirroring real
 * Razorpay's own behaviour — the item-7 ceiling-refusal demo works
 * identically against this fake and against `ManualCaptureRail`.
 */
export class FakePaymentRail implements PaymentRail {
  readonly name = 'manual_capture' as const
  private readonly scenarios = new Map<string, AuthorizeScenario>()
  private readonly authorized = new Map<string, AuthorizeResult>() // keyed by idempotencyKey
  private readonly held = new Map<string, HeldAuthorization>() // keyed by authorizationId

  setScenario(idempotencyKey: string, scenario: AuthorizeScenario): void {
    this.scenarios.set(idempotencyKey, scenario)
  }

  async authorize(params: AuthorizeParams): Promise<AuthorizeResult> {
    const existing = this.authorized.get(params.idempotencyKey)
    if (existing) {
      return existing
    }

    const scenario = this.scenarios.get(params.idempotencyKey) ?? 'success'
    if (scenario === 'decline') {
      throw new PaymentRailError(params.reference, new Error('authorization declined (fake scenario)'))
    }
    if (scenario === 'timeout') {
      throw new PaymentRailError(params.reference, new Error('authorization timed out (fake scenario)'))
    }

    const authorizationId = `pay_${ulid()}`
    const result: AuthorizeResult = {
      authorizationId,
      amountPaise: params.amountPaise,
      expiresAt: new Date(params.now.getTime() + MAX_MANUAL_EXPIRY_MINUTES * 60_000),
    }
    this.authorized.set(params.idempotencyKey, result)
    this.held.set(authorizationId, { amountPaise: params.amountPaise, captured: false })
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
