import { isUniqueViolation } from '../adapters/db/postgres-errors.js'
import { createBookingRescheduledEvent } from '../domain/event-factory.js'
import { evaluateLadder } from '../domain/ladder.js'
import { ZERO_PAISE } from '../domain/money.js'
import { Refusal, type RefusalCode } from '../domain/refusals.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { appendRefusalEvent, refuseAgainstBooking } from './refusal.js'
import { ownedByMerchant } from './tenant-guard.js'
import type { AppDeps } from './types.js'

const IDEMPOTENCY_CLAIM_TIMEOUT_MS = 30_000

export interface RescheduleBookingCommand {
  bookingId: string
  newStartsAt: Date
  idempotencyKey: string
}

export interface RescheduleBookingResult {
  bookingId: string
  status: 'CONFIRMED'
  previousStartsAt: string
  startsAt: string
}

export class BookingNotFoundError extends Error {}
/** The booking exists but isn't CONFIRMED — only a confirmed booking can be moved. */
export class BookingNotReschedulableError extends Error {}
export class PolicyVersionNotFoundError extends Error {}

type GateOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_reschedulable' }
  | { kind: 'no_policy_version' }
  | { kind: 'refused'; code: RefusalCode; reason: string }
  | { kind: 'ok'; previousStartsAt: Date }

/**
 * `reschedule` — a self-transition (`CONFIRMED -> CONFIRMED`), not a
 * cancel-and-rebook: same `booking_id`, same deposit, same authorisation,
 * new `starts_at` (docs/03-domain-model.md §3, "Reschedule deserves a
 * note" / brief §2.3 property #6 — "not return, not refund, a move").
 *
 * The gate is a conjunction:
 *
 *  1. **the ladder permits a move.** Evaluated against the booking's
 *     *current* `startsAt` (the "original" appointment, from the
 *     perspective of this request) and the policy *version* it was
 *     confirmed under — never the merchant's current policy
 *     (docs/03-domain-model.md §2), and never an agent-claimed time
 *     (docs/01-architecture.md §5). This session's reading of "permits a
 *     move": only the ladder's free tier (`retainPct === 0`) does — any
 *     tier that would retain something on a cancellation also forbids a
 *     move, which is exactly what closes the dodge slice-5.md names
 *     explicitly: a customer inside the 100%-retention tier can never reach
 *     "next month" to cancel for free from there, because the move itself
 *     is refused before the ladder is ever re-evaluated against a new date.
 *  2. **the target slot is free.** Enforced the same way `hold_slot`
 *     enforces slot uniqueness (dev-logs/004): attempt the write, translate
 *     a unique-violation on `one_live_booking_per_slot` into `SLOT_TAKEN`.
 *     No separate working-hours/collision check beyond that — `hold_slot`
 *     doesn't do one either; the partial unique index is the one thing this
 *     system treats as authoritative for "is this exact slot occupied."
 */
export async function rescheduleBooking(cmd: RescheduleBookingCommand, deps: AppDeps): Promise<RescheduleBookingResult> {
  const claim = await deps.idempotencyStore.claim<RescheduleBookingResult>('reschedule', cmd.idempotencyKey, {
    timeoutMs: deps.idempotencyClaimTimeoutMs ?? IDEMPOTENCY_CLAIM_TIMEOUT_MS,
  })
  if (claim.kind === 'completed') {
    return claim.response
  }
  if (claim.kind === 'timed_out') {
    return refuseAgainstBooking(deps, cmd.bookingId, {
      attemptedType: 'reschedule',
      code: 'IDEMPOTENT_REPLAY',
      reason: `a reschedule request with idempotency key ${cmd.idempotencyKey} is already in progress and did not complete in time`,
    })
  }

  try {
    return await rescheduleBookingClaimed(cmd, deps)
  } catch (err) {
    await deps.idempotencyStore.release('reschedule', cmd.idempotencyKey)
    throw err
  }
}

async function rescheduleBookingClaimed(cmd: RescheduleBookingCommand, deps: AppDeps): Promise<RescheduleBookingResult> {
  let outcome: GateOutcome
  try {
    outcome = await deps.eventStore.transaction<GateOutcome>(async (tx) => {
      const snapshot = ownedByMerchant(await tx.loadSnapshotForUpdate(cmd.bookingId), deps.merchantId)
      if (!snapshot) {
        return { kind: 'not_found' }
      }
      if (snapshot.status !== 'CONFIRMED') {
        return { kind: 'not_reschedulable' }
      }
      if (snapshot.policyVersion === undefined) {
        return { kind: 'no_policy_version' }
      }

      const nextSequence = snapshot.lastEventSequence + 1
      const refuse = async (code: RefusalCode, reason: string): Promise<GateOutcome> => {
        await appendRefusalEvent({
          tx,
          clock: deps.clock,
          bookingId: snapshot.bookingId,
          sequence: nextSequence,
          attemptedType: 'reschedule',
          code,
          reason,
          merchantId: deps.merchantId,
          projection: { ...snapshot, lastEventSequence: nextSequence },
        })
        return { kind: 'refused', code, reason }
      }

      const policy = await deps.catalogRepo.getPolicyVersion(deps.merchantId, snapshot.policyVersion)
      if (!policy) {
        return { kind: 'no_policy_version' }
      }

      const now = deps.clock.now()
      const ladder = evaluateLadder(policy.cancellationLadder, snapshot.startsAt, now)
      if (ladder.retainPct > 0) {
        return refuse(
          'LADDER_FORBIDS_MOVE',
          `booking ${snapshot.bookingId} is ${ladder.hoursUntil.toFixed(2)}h from its appointment (ladder tier retains ${ladder.retainPct}%) — too close in to reschedule; cancel instead, accepting the tier`,
        )
      }

      const event = createBookingRescheduledEvent(snapshot.bookingId, nextSequence, deps.clock, {
        previousStartsAt: snapshot.startsAt,
        newStartsAt: cmd.newStartsAt,
        priceDeltaPaise: ZERO_PAISE,
      })
      const projection: BookingSnapshot = { ...snapshot, startsAt: cmd.newStartsAt, lastEventSequence: nextSequence }
      await tx.append([event], projection, deps.merchantId) // may throw a unique-violation — caught below

      return { kind: 'ok', previousStartsAt: snapshot.startsAt }
    })
  } catch (err) {
    if (isUniqueViolation(err, 'one_live_booking_per_slot')) {
      const reason = `target slot at ${cmd.newStartsAt.toISOString()} is already taken by another live booking`
      // The transaction above rolled back entirely on the constraint
      // violation, so nothing — including the attempted event — landed.
      // Record the refusal against the (still-existing, still-CONFIRMED)
      // booking in a fresh transaction, same shape as hold_slot's
      // refuseStandalone but against a real booking rather than an
      // ephemeral one.
      await deps.eventStore.transaction(async (tx) => {
        const fresh = await tx.loadSnapshotForUpdate(cmd.bookingId)
        if (!fresh) return
        const sequence = fresh.lastEventSequence + 1
        await appendRefusalEvent({
          tx,
          clock: deps.clock,
          bookingId: cmd.bookingId,
          sequence,
          attemptedType: 'reschedule',
          code: 'SLOT_TAKEN',
          reason,
          merchantId: deps.merchantId,
          projection: { ...fresh, lastEventSequence: sequence },
        })
      })
      throw new Refusal('SLOT_TAKEN', reason)
    }
    throw err
  }

  if (outcome.kind === 'not_found') {
    throw new BookingNotFoundError(`unknown booking: ${cmd.bookingId}`)
  }
  if (outcome.kind === 'not_reschedulable') {
    throw new BookingNotReschedulableError(`booking ${cmd.bookingId} is not CONFIRMED — only a confirmed booking can be rescheduled`)
  }
  if (outcome.kind === 'no_policy_version') {
    throw new PolicyVersionNotFoundError(`booking ${cmd.bookingId} has no policyVersion on record, or that version no longer exists`)
  }
  if (outcome.kind === 'refused') {
    throw new Refusal(outcome.code, outcome.reason)
  }

  const result: RescheduleBookingResult = {
    bookingId: cmd.bookingId,
    status: 'CONFIRMED',
    previousStartsAt: outcome.previousStartsAt.toISOString(),
    startsAt: cmd.newStartsAt.toISOString(),
  }
  await deps.idempotencyStore.put('reschedule', cmd.idempotencyKey, result)
  return result
}
