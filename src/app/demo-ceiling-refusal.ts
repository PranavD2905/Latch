import { addPaise, toPaise } from '../domain/money.js'
import { CaptureAmountMismatchError } from '../ports/payment-rail.js'
import { appendRefusalEvent } from './refusal.js'
import { ownedByMerchant } from './tenant-guard.js'
import type { AppDeps } from './types.js'

export class BookingNotFoundError extends Error {}
export class NoAuthorizationFoundError extends Error {}

export interface CeilingRefusalDemoResult {
  bookingId: string
  authorizationId: string
  authorizedAmountPaise: number
  attemptedAmountPaise: number
  refusalCode: 'CAPTURE_AMOUNT_MISMATCH'
  railMessage: string
}

/**
 * slice-4.md item 7 — the pitch-video beat (2:00-2:45). Deliberately
 * requests a capture *one paisa above* the authorised amount against
 * whichever `PaymentRail` is wired in (`FakePaymentRail` reproduces
 * `ManualCaptureRail`'s real behaviour exactly — see `fake-payment-rail.ts`)
 * and proves the rail itself refuses it: not an `if` in our own code
 * (docs/01-architecture.md Idea 3 / dev-logs/005). On refusal, records an
 * `ACTION_REFUSED` event naming `payment_rail` as the enforcer, so the trail
 * shows the bound *working*, not just documents that it exists.
 *
 * Repointed at the **session-complete** mandate (previously the no-show
 * authorisation, removed along with that feature — see the dev log for that
 * removal). Same demonstration either way: a rail-enforced ceiling with zero
 * headroom that our own server cannot talk its way past.
 *
 * Trivially triggerable on demand via `npm run demo:ceiling-refusal`
 * (`src/adapters/demo/ceiling-refusal.ts`), against a fresh booking or an
 * existing one.
 */
export async function demoCeilingRefusal(bookingId: string, deps: AppDeps): Promise<CeilingRefusalDemoResult> {
  const snapshot = ownedByMerchant(await deps.eventStore.loadSnapshot(bookingId), deps.merchantId)
  if (!snapshot) {
    throw new BookingNotFoundError(`unknown booking: ${bookingId}`)
  }
  if (!snapshot.sessionCompleteAuthorizationId || !snapshot.sessionCompleteAuthorizationAmountPaise) {
    throw new NoAuthorizationFoundError(`booking ${bookingId} has no live session-complete authorization to demonstrate the ceiling against`)
  }

  const authorizationId = snapshot.sessionCompleteAuthorizationId
  const authorizedAmountPaise = snapshot.sessionCompleteAuthorizationAmountPaise
  const attemptedAmountPaise = addPaise(authorizedAmountPaise, toPaise(1))

  try {
    await deps.paymentRail.captureAuthorization({ authorizationId, amountPaise: attemptedAmountPaise, reference: bookingId })
  } catch (err) {
    if (!(err instanceof CaptureAmountMismatchError)) {
      throw err
    }

    await deps.eventStore.transaction(async (tx) => {
      const fresh = await tx.loadSnapshotForUpdate(bookingId)
      const sequence = (fresh?.lastEventSequence ?? snapshot.lastEventSequence) + 1
      await appendRefusalEvent({
        tx,
        clock: deps.clock,
        bookingId,
        sequence,
        attemptedType: 'mark_complete',
        code: 'CAPTURE_AMOUNT_MISMATCH',
        reason: err.message,
        merchantId: deps.merchantId,
        ...(fresh ? { projection: { ...fresh, lastEventSequence: sequence } } : {}),
      })
    })

    return { bookingId, authorizationId, authorizedAmountPaise, attemptedAmountPaise, refusalCode: 'CAPTURE_AMOUNT_MISMATCH', railMessage: err.message }
  }

  // Only reachable if the rail accepted an over-amount capture — the
  // opposite of what this demo exists to prove.
  throw new Error(`demo invariant violated: the rail accepted a capture (₹${attemptedAmountPaise}) above the authorised amount (₹${authorizedAmountPaise})`)
}
