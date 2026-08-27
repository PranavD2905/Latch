import { createAuthorizationReleasedEvent, createBookingCompletedEvent, createSessionCompleteChargedEvent } from '../domain/event-factory.js'
import type { BookingEvent, MoneyAction } from '../domain/events.js'
import { subtractPaise, type Paise } from '../domain/money.js'
import { Refusal } from '../domain/refusals.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { CaptureAmountMismatchError } from '../ports/payment-rail.js'
import { appendRefusalEvent } from './refusal.js'
import { ownedByMerchant } from './tenant-guard.js'
import type { AppDeps } from './types.js'

export interface MarkSessionCompleteCommand {
  bookingId: string
  idempotencyKey: string
}

export interface MarkSessionCompleteResult {
  bookingId: string
  status: 'COMPLETED'
  /** `undefined` when the service's price exactly equalled the deposit at confirm time — nothing was left to authorise or capture. */
  charge: { paymentId: string; amountPaise: number } | undefined
}

export class BookingNotFoundError extends Error {}
/** The booking exists but isn't in a state a completion charge can apply to — not CONFIRMED (already charged, cancelled, declined, already completed, ...). */
export class BookingNotCompletableError extends Error {}

interface CaptureOutcome {
  action: MoneyAction
  ceilingPaise: Paise
  headroomAfterPaise: Paise
  authorizationId: string
  paymentId: string
}

/**
 * `mark_complete` — merchant-only, same trust boundary as `decline_booking`/
 * `mark_no_show` (never registered as an MCP tool: self-reported attendance
 * from an agent is exactly the kind of fact this system already refuses to
 * take on an agent's say-so, the same reasoning `NON_ATTENDANCE_MARKED`
 * already applies to the no-show side).
 *
 * Unlike no-show's mark-then-charge split (which exists only because
 * `charge_no_show` needed to stay agent-callable, gated on the server's own
 * elapsed-time fact — docs/03-domain-model.md §3 Rule 3), there is no
 * analogous reason to split this into two calls. One merchant action both
 * marks and charges, atomically — the same shape `decline_booking` already
 * uses for its own one-shot merchant action. No time gate either: the
 * merchant asserting the session happened is itself the fact being
 * recorded, not something re-derived from the clock.
 *
 * Captures the session-complete mandate authorised at `confirm_with_deposit`
 * time (`service.pricePaise - policy.depositAmountPaise`, frozen then, never
 * re-derived from the service's current price) and releases the no-show
 * authorisation, if one exists — the patient showing up makes it moot, the
 * same way charging a no-show releases *this* leg in the other direction.
 */
export async function markSessionComplete(cmd: MarkSessionCompleteCommand, deps: AppDeps): Promise<MarkSessionCompleteResult> {
  const cached = await deps.idempotencyStore.get<MarkSessionCompleteResult>('mark_complete', cmd.idempotencyKey)
  if (cached) {
    return cached
  }

  const snapshot = ownedByMerchant(await deps.eventStore.loadSnapshot(cmd.bookingId), deps.merchantId)
  if (!snapshot) {
    throw new BookingNotFoundError(`unknown booking: ${cmd.bookingId}`)
  }
  if (snapshot.status !== 'CONFIRMED') {
    throw new BookingNotCompletableError(`booking ${cmd.bookingId} is not CONFIRMED — only a confirmed booking can be marked complete`)
  }

  let capture: CaptureOutcome | undefined
  // No mandate to capture — the ₹0 edge case (service priced exactly at the
  // deposit, confirm_with_deposit.ts skipped authorising anything).
  if (snapshot.sessionCompleteAuthorizationId && snapshot.sessionCompleteAuthorizationAmountPaise) {
    const authorizationId = snapshot.sessionCompleteAuthorizationId
    const authorizationAmountPaise = snapshot.sessionCompleteAuthorizationAmountPaise

    // Outside any DB lock, deliberately — same discipline as charge_no_show/
    // decline_booking: never hold a row lock across a network call.
    try {
      const captured = await deps.paymentRail.captureAuthorization({ authorizationId, amountPaise: authorizationAmountPaise, reference: cmd.bookingId })
      capture = {
        action: { direction: 'debit', amountPaise: captured.amountPaise, instrument: captured.instrument },
        ceilingPaise: authorizationAmountPaise,
        headroomAfterPaise: subtractPaise(authorizationAmountPaise, captured.amountPaise),
        authorizationId,
        paymentId: captured.paymentId,
      }
    } catch (err) {
      if (err instanceof CaptureAmountMismatchError) {
        await deps.eventStore.transaction(async (tx) => {
          const fresh = await tx.loadSnapshotForUpdate(cmd.bookingId)
          const sequence = (fresh?.lastEventSequence ?? snapshot.lastEventSequence) + 1
          await appendRefusalEvent({
            tx,
            clock: deps.clock,
            bookingId: cmd.bookingId,
            sequence,
            attemptedType: 'mark_complete',
            code: 'CAPTURE_AMOUNT_MISMATCH',
            reason: err.message,
            merchantId: deps.merchantId,
            ...(fresh ? { projection: { ...fresh, lastEventSequence: sequence } } : {}),
          })
        })
        throw new Refusal('CAPTURE_AMOUNT_MISMATCH', err.message)
      }
      throw err
    }
  }

  await deps.eventStore.transaction(async (tx) => {
    const fresh = await tx.loadSnapshotForUpdate(cmd.bookingId)
    const base = fresh ?? snapshot
    let sequence = base.lastEventSequence
    const events: BookingEvent[] = []

    if (capture) {
      events.push(
        createSessionCompleteChargedEvent(cmd.bookingId, ++sequence, deps.clock, {
          rail: deps.paymentRail.name,
          action: capture.action,
          gate: { cleared: ['merchant_marked_session_complete'], evidence: { markedBy: 'merchant', startedAt: snapshot.startsAt.toISOString() } },
          bound: { ceilingPaise: capture.ceilingPaise, enforcedBy: 'payment_rail', headroomAfterPaise: capture.headroomAfterPaise },
          authority: { policyVersion: base.policyVersion ?? 0, authorizationId: capture.authorizationId, razorpayPaymentId: capture.paymentId },
        }),
      )
    }

    // The no-show authorisation, if one exists, is now moot — the patient
    // showed up. Same "release means we simply never capture" discipline as
    // decline_booking/cancel_booking (dev-logs/005: no void endpoint).
    if (base.authorizationId && base.authorizationExpiresAt && !base.authorizationLapsedAt) {
      events.push(
        createAuthorizationReleasedEvent(cmd.bookingId, ++sequence, deps.clock, {
          authorizationId: base.authorizationId,
          rail: deps.paymentRail.name,
          expiresAt: base.authorizationExpiresAt,
        }),
      )
    }

    // Nothing to append (no mandate captured, no no-show authorisation to
    // release) — still a real transition, so it needs a real event. Reuses
    // the dead-until-now BOOKING_COMPLETED type for exactly the shape it was
    // always meant for: no money, just the fact.
    if (events.length === 0) {
      events.push(createBookingCompletedEvent(cmd.bookingId, ++sequence, deps.clock, {}))
    }

    const projection: BookingSnapshot = {
      ...base,
      status: 'COMPLETED',
      authorizationId: undefined,
      sessionCompleteAuthorizationId: undefined,
      lastEventSequence: sequence,
    }

    await tx.append(events, projection, deps.merchantId)
  })

  const result: MarkSessionCompleteResult = {
    bookingId: cmd.bookingId,
    status: 'COMPLETED',
    charge: capture ? { paymentId: capture.paymentId, amountPaise: capture.action.amountPaise } : undefined,
  }
  await deps.idempotencyStore.put('mark_complete', cmd.idempotencyKey, result)
  return result
}
