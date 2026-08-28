import type { Instrument, PaymentRail as PaymentRailName } from '../domain/events.js'
import type { Paise } from '../domain/money.js'
import type { PaymentStatusValue } from './payment-provider.js'

export interface AuthorizeParams {
  /** Exactly the no-show fee — docs/01-architecture.md Idea 3: authorised at the ceiling itself, no headroom. */
  amountPaise: Paise
  idempotencyKey: string
  /** What this authorisation is for, for the rail's own reference — the bookingId here. */
  reference: string
  /**
   * The server clock's `now`, from `Clock.now()` — docs/01-architecture.md
   * §5: "the server clock is the only clock." `expiresAt` is computed from
   * this, not the adapter's own wall-clock read, so tests can drive a
   * `FrozenClock` forward and deterministically observe an authorisation
   * lapse rather than waiting on real time.
   */
  now: Date
}

export interface AuthorizeResult {
  authorizationId: string
  amountPaise: Paise
  /** When this rail's authorisation window lapses — `manual_capture` reports its `manual_expiry_period`. */
  expiresAt: Date
}

export interface CaptureAuthorizationParams {
  authorizationId: string
  /** Must equal the amount `authorize()` returned — docs/01-architecture.md Idea 3, constraint 1: the rail refuses anything else. */
  amountPaise: Paise
  reference: string
}

export interface CaptureAuthorizationResult {
  paymentId: string
  amountPaise: Paise
  instrument: Instrument
}

/**
 * dev-logs/005 constraint 1, made a distinct error type: the rail's own
 * refusal when a capture does not equal the amount authorised. This is the
 * error the Slice 4 ceiling-refusal demo (slice-4.md item 7) triggers and
 * asserts on — `charge_no_show`/the demo script maps it to the
 * `CAPTURE_AMOUNT_MISMATCH` refusal code and records an `ACTION_REFUSED`
 * event naming `payment_rail` as the enforcer.
 */
export class CaptureAmountMismatchError extends Error {
  constructor(reference: string, requestedPaise: number) {
    super(`Capture amount ${requestedPaise} for ${reference} does not equal the amount authorized — the rail refuses any capture that isn't exact`)
    this.name = 'CaptureAmountMismatchError'
  }
}

export class AuthorizationNotFoundError extends Error {
  constructor(authorizationId: string) {
    super(`No authorization found for ${authorizationId}`)
    this.name = 'AuthorizationNotFoundError'
  }
}

/**
 * Optional, provider-agnostic detail an adapter can attach when it knows
 * more about `cause` than this port does — e.g. Razorpay's own `{ error:
 * { code, description } }` shape, parsed by `razorpay-shared.ts`'s
 * `parseRazorpaySdkError` and never imported here (this port must stay
 * implementable by any `PaymentRail`, not just a Razorpay one).
 */
export interface PaymentRailErrorDetails {
  code?: string | undefined
  description?: string | undefined
}

/**
 * Distinct from `CaptureAmountMismatchError`/`AuthorizationNotFoundError`,
 * which are expected business/gate outcomes. This is an unexpected failure
 * talking to the rail itself — mirrors `PaymentProviderError` on the
 * `PaymentProvider` port (dev-logs/006). Never leak the raw SDK error to a
 * caller. `reference`/`providerErrorCode`/`providerErrorDescription` are
 * plain own properties (not just folded into the message string) so a
 * structured logger picks them up automatically wherever this error is
 * logged (Pino's `err` serializer copies an error's own enumerable
 * properties) — dev-logs/019. `reference` is a bookingId for every throw
 * site except `fetchAuthorizationStatus`'s, which passes the
 * `authorizationId` it was looking up — named generically rather than
 * `bookingId` so it stays accurate at that one call site too.
 */
export class PaymentRailError extends Error {
  readonly reference: string
  readonly providerErrorCode: string | undefined
  readonly providerErrorDescription: string | undefined

  constructor(reference: string, cause: unknown, details?: PaymentRailErrorDetails) {
    super(`Unexpected payment rail error for ${reference}: ${describeCause(cause)}`)
    this.name = 'PaymentRailError'
    this.cause = cause
    this.reference = reference
    this.providerErrorCode = details?.code
    this.providerErrorDescription = details?.description
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (cause && typeof cause === 'object' && 'description' in cause) return String((cause as { description: unknown }).description)
  return String(cause)
}

/**
 * Outbound port for the no-show authorisation leg — docs/01-architecture.md
 * Idea 3 / dev-logs/005. Deliberately separate from `PaymentProvider`
 * (deposit capture/refund): the deposit is captured immediately, but the
 * no-show fee is *authorised* now and *captured* weeks later, against a
 * ceiling the rail itself enforces. `src/app/` and `src/domain/` depend only
 * on this interface — no `capture`/`payment_capture` semantics, and no
 * Razorpay SDK type, cross into either.
 *
 * There is deliberately no `release()` method. Razorpay documents no void
 * endpoint (dev-logs/005) — "releasing" an authorisation is simply never
 * calling `captureAuthorization` on it and letting Razorpay auto-refund it
 * at `expiresAt`. A method that did nothing but log would be dishonest; the
 * app layer records the release as a pure bookkeeping event
 * (`AUTHORIZATION_RELEASED`) with no corresponding rail call at all.
 */
export interface AuthorizationStatus {
  status: PaymentStatusValue
  amountPaise: Paise
}

export interface PaymentRail {
  readonly name: PaymentRailName
  authorize(params: AuthorizeParams): Promise<AuthorizeResult>
  captureAuthorization(params: CaptureAuthorizationParams): Promise<CaptureAuthorizationResult>
  /** dev-logs/014 — the rail-side twin of `PaymentProvider.fetchPaymentStatus`, for the reconciliation worker. */
  fetchAuthorizationStatus(authorizationId: string): Promise<AuthorizationStatus>
}
