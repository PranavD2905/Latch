import { createNoShowChargedEvent } from '../domain/event-factory.js'
import { subtractPaise, type Paise } from '../domain/money.js'
import { Refusal, type RefusalCode } from '../domain/refusals.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { CaptureAmountMismatchError } from '../ports/payment-rail.js'
import { NoActivePolicyError } from './get-policy.js'
import { appendRefusalEvent, refuseAgainstBooking } from './refusal.js'
import type { AppDeps } from './types.js'

const IDEMPOTENCY_CLAIM_TIMEOUT_MS = 30_000

export interface ChargeNoShowCommand {
  bookingId: string
  idempotencyKey: string
}

export interface ChargeNoShowResult {
  bookingId: string
  status: 'NO_SHOW_CHARGED'
  charge: {
    paymentId: string
    amountPaise: number
  }
}

export class BookingNotFoundError extends Error {}
/** The booking exists but isn't in a state a no-show charge can apply to — not CONFIRMED (already charged, still HELD, declined, ...). */
export class BookingNotChargeableError extends Error {}
/** A CONFIRMED booking with no authorization on it would be a prior-slice bug (every confirm_with_deposit registers one) — not a real state. */
export class NoAuthorizationFoundError extends Error {}

type GateOutcome =
  | { kind: 'ok'; snapshot: BookingSnapshot; authorizationId: string; authorizationAmountPaise: Paise }
  | { kind: 'refused'; code: RefusalCode; reason: string }
  | { kind: 'not_found' }
  | { kind: 'not_chargeable' }
  | { kind: 'no_authorization' }

/**
 * `charge_no_show` — docs/03-domain-model.md §3 Rule 3 / §4: the most
 * dangerous money action in the system, gated on two independent facts from
 * two different authorities. Agent-callable (it's one of the seven MCP
 * tools), but it cannot succeed on an agent's say-so alone:
 *
 *  1. appointment start + grace elapsed — the **server clock** owns this,
 *     never an agent's claim (docs/01-architecture.md §5)
 *  2. merchant explicitly marked non-attendance — only the merchant API's
 *     mark-no-show route can set `nonAttendanceMarkedAt`; no agent-facing
 *     path exists that could forge it
 *
 * Both are checked from the `bookings` projection under a row lock (same
 * two-transaction shape as `confirm_with_deposit`/`decline_booking`: gate
 * under a lock, the real Razorpay capture strictly outside any lock, then a
 * final transaction appends the trail event and flips the projection).
 */
export async function chargeNoShow(cmd: ChargeNoShowCommand, deps: AppDeps): Promise<ChargeNoShowResult> {
  const claim = await deps.idempotencyStore.claim<ChargeNoShowResult>('charge_no_show', cmd.idempotencyKey, {
    timeoutMs: deps.idempotencyClaimTimeoutMs ?? IDEMPOTENCY_CLAIM_TIMEOUT_MS,
  })
  if (claim.kind === 'completed') {
    return claim.response
  }
  if (claim.kind === 'timed_out') {
    return refuseAgainstBooking(deps, cmd.bookingId, {
      attemptedType: 'charge_no_show',
      code: 'IDEMPOTENT_REPLAY',
      reason: `a charge_no_show request with idempotency key ${cmd.idempotencyKey} is already in progress and did not complete in time`,
    })
  }

  try {
    return await chargeNoShowClaimed(cmd, deps)
  } catch (err) {
    await deps.idempotencyStore.release('charge_no_show', cmd.idempotencyKey)
    throw err
  }
}

async function chargeNoShowClaimed(cmd: ChargeNoShowCommand, deps: AppDeps): Promise<ChargeNoShowResult> {
  const policy = await deps.catalogRepo.getActivePolicy(deps.merchantId)
  if (!policy) {
    throw new NoActivePolicyError(`no active policy for merchant ${deps.merchantId}`)
  }

  const gateOutcome = await deps.eventStore.transaction<GateOutcome>(async (tx) => {
    const snapshot = await tx.loadSnapshotForUpdate(cmd.bookingId)
    if (!snapshot) {
      return { kind: 'not_found' }
    }
    if (snapshot.status !== 'CONFIRMED') {
      return { kind: 'not_chargeable' }
    }
    if (!snapshot.authorizationId || !snapshot.authorizationAmountPaise) {
      return { kind: 'no_authorization' }
    }

    const nextSequence = snapshot.lastEventSequence + 1
    const refuse = async (code: RefusalCode, reason: string): Promise<GateOutcome> => {
      await appendRefusalEvent({
        tx,
        clock: deps.clock,
        bookingId: snapshot.bookingId,
        sequence: nextSequence,
        attemptedType: 'charge_no_show',
        code,
        reason,
        projection: { ...snapshot, lastEventSequence: nextSequence },
      })
      return { kind: 'refused', code, reason }
    }

    const now = deps.clock.now()
    const eligibleAt = new Date(snapshot.startsAt.getTime() + policy.noShowGraceMinutes * 60_000)
    if (now.getTime() < eligibleAt.getTime()) {
      return refuse(
        'NOT_YET_ELIGIBLE',
        `no-show charge for ${snapshot.bookingId} not eligible until ${eligibleAt.toISOString()} (appointment start + ${policy.noShowGraceMinutes}m grace)`,
      )
    }

    if (snapshot.authorizationExpiresAt && now.getTime() >= snapshot.authorizationExpiresAt.getTime()) {
      return refuse(
        'AUTHORIZATION_EXPIRED',
        `authorization ${snapshot.authorizationId} for ${snapshot.bookingId} lapsed at ${snapshot.authorizationExpiresAt.toISOString()} — the no-show fee is uncollectable`,
      )
    }

    if (!snapshot.nonAttendanceMarkedAt) {
      return refuse('MERCHANT_ACTION_REQUIRED', `no-show charge for ${snapshot.bookingId} requires the merchant to mark non-attendance first`)
    }

    return { kind: 'ok', snapshot, authorizationId: snapshot.authorizationId, authorizationAmountPaise: snapshot.authorizationAmountPaise }
  })

  if (gateOutcome.kind === 'not_found') {
    throw new BookingNotFoundError(`unknown booking: ${cmd.bookingId}`)
  }
  if (gateOutcome.kind === 'not_chargeable') {
    throw new BookingNotChargeableError(`booking ${cmd.bookingId} is not CONFIRMED — only a confirmed booking can be charged for a no-show`)
  }
  if (gateOutcome.kind === 'no_authorization') {
    throw new NoAuthorizationFoundError(`booking ${cmd.bookingId} is CONFIRMED but has no authorization registered`)
  }
  if (gateOutcome.kind === 'refused') {
    throw new Refusal(gateOutcome.code, gateOutcome.reason)
  }

  const { snapshot, authorizationId, authorizationAmountPaise } = gateOutcome

  // Outside any DB lock, deliberately — same discipline as
  // confirm_with_deposit/decline_booking: never hold a row lock across a
  // network call. Captures the amount that was actually *authorised*
  // (recorded on this booking at confirm_with_deposit time), never the
  // merchant's current policy figure — see BookingSnapshot.authorizationAmountPaise.
  // dev-logs/005 constraint 1: the rail refuses any capture that isn't
  // exactly the authorised amount — this is where that becomes real for a
  // caller, not just documented.
  let captured
  try {
    captured = await deps.paymentRail.captureAuthorization({
      authorizationId,
      amountPaise: authorizationAmountPaise,
      reference: cmd.bookingId,
    })
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
          attemptedType: 'charge_no_show',
          code: 'CAPTURE_AMOUNT_MISMATCH',
          reason: err.message,
          ...(fresh ? { projection: { ...fresh, lastEventSequence: sequence } } : {}),
        })
      })
      throw new Refusal('CAPTURE_AMOUNT_MISMATCH', err.message)
    }
    throw err
  }

  await deps.eventStore.transaction(async (tx) => {
    const fresh = await tx.loadSnapshotForUpdate(cmd.bookingId)
    const base = fresh ?? snapshot
    const sequence = base.lastEventSequence + 1

    const chargedEvent = createNoShowChargedEvent(cmd.bookingId, sequence, deps.clock, {
      rail: deps.paymentRail.name,
      action: { direction: 'debit', amountPaise: captured.amountPaise, instrument: captured.instrument },
      gate: {
        cleared: ['start_time_elapsed', 'merchant_marked_non_attendance'],
        evidence: {
          startedAt: snapshot.startsAt.toISOString(),
          markedBy: 'merchant',
          markedAt: snapshot.nonAttendanceMarkedAt?.toISOString(),
        },
      },
      bound: {
        ceilingPaise: authorizationAmountPaise,
        enforcedBy: 'payment_rail',
        headroomAfterPaise: subtractPaise(authorizationAmountPaise, captured.amountPaise),
      },
      // The policy version the booking was actually confirmed under
      // (docs/03-domain-model.md §2: "a booking made under ladder v4 must be
      // cancelled [charged] under ladder v4"), falling back to the
      // merchant's current version only in the defensive case that's never
      // meant to happen (a CONFIRMED booking with no recorded policyVersion).
      authority: { policyVersion: snapshot.policyVersion ?? policy.policyVersion, authorizationId, razorpayPaymentId: captured.paymentId },
    })

    const projection: BookingSnapshot = { ...base, status: 'NO_SHOW_CHARGED', lastEventSequence: sequence }
    await tx.append([chargedEvent], projection)
  })

  const result: ChargeNoShowResult = {
    bookingId: cmd.bookingId,
    status: 'NO_SHOW_CHARGED',
    charge: { paymentId: captured.paymentId, amountPaise: captured.amountPaise },
  }
  await deps.idempotencyStore.put('charge_no_show', cmd.idempotencyKey, result)
  return result
}
