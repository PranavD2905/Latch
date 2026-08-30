import type { PaymentRequestedLeg } from '../domain/events.js'
import type { Paise } from '../domain/money.js'
import { executePaymentCall } from './payment-circuit-breaker.js'
import type { AppDeps } from './types.js'

export interface PendingLegStatus {
  leg: PaymentRequestedLeg['leg']
  label: string
  amountPaise: Paise
  done: boolean
}

/**
 * Payment-link feature follow-up: `get_booking` and the `/pay` page both
 * need to know, live, whether a leg `confirm_with_deposit` requested a link
 * for has actually landed — *before* the booking's own trail records it
 * (`DEPOSIT_CAPTURED`/`AUTHORIZATION_HELD` only get appended once every
 * applicable leg is done, in one atomic finalize — see
 * `confirm-with-deposit.ts`'s own comment on why). A one-shot check
 * (`timeoutMs: 0` — the same poll methods `confirm_with_deposit` itself
 * uses, just without waiting) against the rail directly, never against our
 * own projection, so this is always the truth as Razorpay currently sees
 * it. Read-only — no gate, no money moved, matching `get_booking`'s own
 * contract — and never throws: a rail hiccup checking status is not a
 * reason to break either caller, so it's reported as `done: false` (the
 * conservative default — never claim something is paid when we couldn't
 * actually confirm that).
 */
export async function checkPendingLegStatus(deps: AppDeps, leg: PaymentRequestedLeg, reference: string, now: Date): Promise<PendingLegStatus> {
  const order = { orderId: leg.orderId, amountPaise: leg.amountPaise }
  try {
    const result =
      leg.leg === 'deposit'
        ? await executePaymentCall(deps.paymentCircuitBreaker, () => deps.paymentProvider.pollDepositCapture(order, reference, { timeoutMs: 0 }))
        : await executePaymentCall(deps.paymentCircuitBreaker, () => deps.paymentRail.pollAuthorization(order, reference, now, { timeoutMs: 0 }))
    return { leg: leg.leg, label: leg.label, amountPaise: leg.amountPaise, done: result !== undefined }
  } catch {
    return { leg: leg.leg, label: leg.label, amountPaise: leg.amountPaise, done: false }
  }
}

/** Runs `checkPendingLegStatus` for every leg on a booking's `pendingPaymentLegs`, concurrently. `undefined` if there's nothing pending. */
export async function checkAllPendingLegs(deps: AppDeps, legs: readonly PaymentRequestedLeg[] | undefined, reference: string, now: Date): Promise<readonly PendingLegStatus[] | undefined> {
  if (!legs || legs.length === 0) return undefined
  return Promise.all(legs.map((leg) => checkPendingLegStatus(deps, leg, reference, now)))
}
