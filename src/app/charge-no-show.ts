import { createNoShowChargedEvent, createSessionCompleteAuthorizationReleasedEvent } from '../domain/event-factory.js'
import type { BookingEvent } from '../domain/events.js'
import { subtractPaise, type Paise } from '../domain/money.js'
import { Refusal, type RefusalCode } from '../domain/refusals.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { CaptureAmountMismatchError } from '../ports/payment-rail.js'
import { NoActivePolicyError } from './get-policy.js'
import { appendRefusalEvent, refuseAgainstBooking } from './refusal.js'
import { ownedByMerchant } from './tenant-guard.js'
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

type GateOutcome =
  | { kind: 'ok'; snapshot: BookingSnapshot; authorizationId: string; authorizationAmountPaise: Paise }
  | { kind: 'refused'; code: RefusalCode; reason: string }
  | { kind: 'not_found' }
  | { kind: 'not_chargeable' }

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
    const snapshot = ownedByMerchant(await tx.loadSnapshotForUpdate(cmd.bookingId), deps.merchantId)
    if (!snapshot) {
      return { kind: 'not_found' }
    }
    if (snapshot.status !== 'CONFIRMED') {
      return { kind: 'not_chargeable' }
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
        merchantId: deps.merchantId,
        projection: { ...snapshot, lastEventSequence: nextSequence },
      })
      return { kind: 'refused', code, reason }
    }

    // The no-show fee is optional now (this task): a booking confirmed
    // under a policy version with no no-show fee configured never got an
    // authorisation registered at all — an expected, agent-facing outcome,
    // not a prior-slice bug. If the *current* policy also no longer defines
    // a grace period, there's nothing to check eligibility against either
    // way, so the same refusal covers it.
    if (!snapshot.authorizationId || !snapshot.authorizationAmountPaise) {
      return refuse('NO_SHOW_FEE_NOT_CONFIGURED', `booking ${snapshot.bookingId}'s policy has no no-show fee configured — there is no authorisation to capture`)
    }
    if (policy.noShowGraceMinutes === undefined) {
      return refuse('NO_SHOW_FEE_NOT_CONFIGURED', `merchant ${deps.merchantId}'s current policy no longer configures a no-show fee — eligibility cannot be evaluated`)
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
          merchantId: deps.merchantId,
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
    let sequence = base.lastEventSequence + 1

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

    const events: BookingEvent[] = [chargedEvent]
    // The patient didn't show, so whatever the session-complete mandate was
    // authorised for is now moot — released the same way decline_booking/
    // cancel_booking already release it on their own terminal outcomes, so
    // no orphaned authority is left claiming a session that will never
    // complete is still owed. No rail call (dev-logs/005: no void endpoint)
    // — Razorpay auto-refunds it at `expiresAt` on its own.
    if (base.sessionCompleteAuthorizationId && base.sessionCompleteAuthorizationExpiresAt && !base.sessionCompleteAuthorizationLapsedAt) {
      events.push(
        createSessionCompleteAuthorizationReleasedEvent(cmd.bookingId, ++sequence, deps.clock, {
          authorizationId: base.sessionCompleteAuthorizationId,
          rail: deps.paymentRail.name,
          expiresAt: base.sessionCompleteAuthorizationExpiresAt,
        }),
      )
    }

    const projection: BookingSnapshot = {
      ...base,
      status: 'NO_SHOW_CHARGED',
      sessionCompleteAuthorizationId: undefined,
      lastEventSequence: sequence,
    }
    await tx.append(events, projection, deps.merchantId)
  })

  const result: ChargeNoShowResult = {
    bookingId: cmd.bookingId,
    status: 'NO_SHOW_CHARGED',
    charge: { paymentId: captured.paymentId, amountPaise: captured.amountPaise },
  }
  await deps.idempotencyStore.put('charge_no_show', cmd.idempotencyKey, result)
  return result
}
