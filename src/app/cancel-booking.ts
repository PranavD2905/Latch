import {
  createCancelledByCustomerEvent,
  createRefundIssuedEvent,
  createRetentionAppliedEvent,
  createSessionCompleteAuthorizationReleasedEvent,
} from '../domain/event-factory.js'
import type { DepositCapturedEvent } from '../domain/events.js'
import { evaluateLadder } from '../domain/ladder.js'
import { floorPercentageOf, subtractPaise, type Paise } from '../domain/money.js'
import type { Policy } from '../domain/policy.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { executePaymentCall } from './payment-circuit-breaker.js'
import { refuseAgainstBooking } from './refusal.js'
import { ownedByMerchant } from './tenant-guard.js'
import type { AppDeps } from './types.js'

const IDEMPOTENCY_CLAIM_TIMEOUT_MS = 30_000

export interface CancelBookingCommand {
  bookingId: string
  idempotencyKey: string
}

export interface CancelBookingResult {
  bookingId: string
  status: 'CANCELLED_BY_CUSTOMER'
  retained: { amountPaise: number }
  refund: { refundId: string | undefined; amountPaise: number }
}

export class BookingNotFoundError extends Error {}
/** The booking exists but isn't in a state a customer cancellation can apply to — e.g. still HELD, or already terminal. */
export class BookingNotCancellableError extends Error {}
/** A CONFIRMED booking with no DEPOSIT_CAPTURED event in its history would be a prior-slice bug, not a real state. */
export class NoDepositFoundError extends Error {}
/** A CONFIRMED booking with no policyVersion recorded would be a prior-slice bug — confirm_with_deposit always records one. */
export class PolicyVersionNotFoundError extends Error {}

type GateOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_cancellable' }
  | { kind: 'no_deposit' }
  | { kind: 'no_policy_version' }
  | {
      kind: 'ok'
      startsAt: Date
      policyVersion: number
      deposit: DepositCapturedEvent
    }

/**
 * `cancel` — the customer-caused counterpart to `decline_booking`'s
 * merchant path (dev-logs/008/009), and the one place the cancellation
 * ladder actually applies (docs/03-domain-model.md §3 Rule 2: cause is a
 * required, structural input — `CancelledByCustomerEvent` has no `cause`
 * field at all, unlike `MerchantDeclinedEvent`, because this command is the
 * only caller that can ever construct one).
 *
 * The ladder tier is computed from `deps.clock.now()` at the moment this
 * command is handled, against the booking's *current* `startsAt` — never an
 * agent-supplied timestamp (docs/01-architecture.md §5) — and against the
 * policy *version* the booking was actually confirmed under
 * (`CatalogRepo.getPolicyVersion`), not whatever the merchant's active
 * policy happens to be today (docs/03-domain-model.md §2).
 */
export async function cancelBooking(cmd: CancelBookingCommand, deps: AppDeps): Promise<CancelBookingResult> {
  const claim = await deps.idempotencyStore.claim<CancelBookingResult>('cancel', cmd.idempotencyKey, {
    timeoutMs: deps.idempotencyClaimTimeoutMs ?? IDEMPOTENCY_CLAIM_TIMEOUT_MS,
  })
  if (claim.kind === 'completed') {
    return claim.response
  }
  if (claim.kind === 'timed_out') {
    return refuseAgainstBooking(deps, cmd.bookingId, {
      attemptedType: 'cancel',
      code: 'IDEMPOTENT_REPLAY',
      reason: `a cancel request with idempotency key ${cmd.idempotencyKey} is already in progress and did not complete in time`,
    })
  }

  try {
    return await cancelBookingClaimed(cmd, deps)
  } catch (err) {
    await deps.idempotencyStore.release('cancel', cmd.idempotencyKey)
    throw err
  }
}

async function cancelBookingClaimed(cmd: CancelBookingCommand, deps: AppDeps): Promise<CancelBookingResult> {
  const gateOutcome = await deps.eventStore.transaction<GateOutcome>(async (tx) => {
    const snapshot = ownedByMerchant(await tx.loadSnapshotForUpdate(cmd.bookingId), deps.merchantId)
    if (!snapshot) {
      return { kind: 'not_found' }
    }
    if (snapshot.status !== 'CONFIRMED') {
      return { kind: 'not_cancellable' }
    }

    const history = await tx.loadEvents(cmd.bookingId)
    const deposit = history.find((e): e is DepositCapturedEvent => e.type === 'DEPOSIT_CAPTURED')
    if (!deposit) {
      return { kind: 'no_deposit' }
    }
    if (snapshot.policyVersion === undefined) {
      return { kind: 'no_policy_version' }
    }

    return {
      kind: 'ok',
      startsAt: snapshot.startsAt,
      policyVersion: snapshot.policyVersion,
      deposit,
    }
  })

  if (gateOutcome.kind === 'not_found') {
    throw new BookingNotFoundError(`unknown booking: ${cmd.bookingId}`)
  }
  if (gateOutcome.kind === 'not_cancellable') {
    throw new BookingNotCancellableError(`booking ${cmd.bookingId} is not CONFIRMED — only a confirmed booking can be cancelled`)
  }
  if (gateOutcome.kind === 'no_deposit') {
    throw new NoDepositFoundError(`booking ${cmd.bookingId} is CONFIRMED but has no DEPOSIT_CAPTURED event in its history`)
  }
  if (gateOutcome.kind === 'no_policy_version') {
    throw new PolicyVersionNotFoundError(`booking ${cmd.bookingId} is CONFIRMED but has no recorded policyVersion`)
  }

  const { startsAt, policyVersion, deposit } = gateOutcome

  const policy: Policy | undefined = await deps.catalogRepo.getPolicyVersion(deps.merchantId, policyVersion)
  if (!policy) {
    throw new PolicyVersionNotFoundError(`booking ${cmd.bookingId} was confirmed under policy v${policyVersion}, but that version no longer exists`)
  }

  const paymentId = deposit.authority.razorpayPaymentId
  if (!paymentId) {
    throw new NoDepositFoundError(`DEPOSIT_CAPTURED for ${cmd.bookingId} has no razorpayPaymentId — cannot refund`)
  }

  // The ladder is evaluated here, outside any lock, deliberately: it is a
  // pure computation over policy + clock, no I/O. `now` is captured once and
  // reused below so the trail's evidence and the actual retained/refunded
  // amounts can never drift from what was evaluated.
  const now = deps.clock.now()
  const ladder = evaluateLadder(policy.cancellationLadder, startsAt, now)
  const retainedAmount: Paise = floorPercentageOf(deposit.action.amountPaise, ladder.retainPct)
  const refundAmount: Paise = subtractPaise(deposit.action.amountPaise, retainedAmount)

  // Outside any DB lock, deliberately — same discipline as decline_booking/
  // confirm_with_deposit: never hold a row lock across a network call. Only
  // called when there is actually something to refund (0% tier and 100%
  // tier are both legitimate — no Razorpay refund of ₹0 is ever attempted).
  const refund =
    refundAmount > 0
      ? await executePaymentCall(deps.paymentCircuitBreaker, () =>
          deps.paymentProvider.refundDeposit({
            paymentId,
            amountPaise: refundAmount,
            idempotencyKey: cmd.idempotencyKey,
            reference: cmd.bookingId,
          }),
        )
      : undefined

  await deps.eventStore.transaction(async (tx) => {
    const fresh = await tx.loadSnapshotForUpdate(cmd.bookingId)
    if (!fresh) {
      throw new BookingNotFoundError(`booking ${cmd.bookingId} disappeared between the gate check and the cancel write`)
    }
    let sequence = fresh.lastEventSequence

    const events = []

    const cancelledEvent = createCancelledByCustomerEvent(cmd.bookingId, ++sequence, deps.clock, {})
    events.push(cancelledEvent)

    if (retainedAmount > 0) {
      events.push(
        createRetentionAppliedEvent(cmd.bookingId, ++sequence, deps.clock, {
          action: { direction: 'credit', amountPaise: retainedAmount, instrument: deposit.action.instrument },
          gate: {
            cleared: ['customer_caused_cancellation', 'ladder_evaluated'],
            evidence: { hoursUntil: ladder.hoursUntil, tierHoursBefore: ladder.tier.hoursBefore, retainPct: ladder.retainPct, policyVersion },
          },
          bound: { ceilingPaise: deposit.action.amountPaise, enforcedBy: 'latch_policy', headroomAfterPaise: refundAmount },
          authority: { policyVersion, razorpayPaymentId: paymentId },
        }),
      )
    }

    if (refund && refundAmount > 0) {
      events.push(
        createRefundIssuedEvent(cmd.bookingId, ++sequence, deps.clock, {
          action: { direction: 'debit', amountPaise: refund.amountPaise, instrument: deposit.action.instrument },
          gate: {
            cleared: ['customer_caused_cancellation', 'ladder_evaluated'],
            evidence: { hoursUntil: ladder.hoursUntil, tierHoursBefore: ladder.tier.hoursBefore, retainPct: ladder.retainPct, policyVersion },
          },
          bound: { ceilingPaise: deposit.action.amountPaise, enforcedBy: 'latch_policy', headroomAfterPaise: retainedAmount },
          authority: { policyVersion, razorpayPaymentId: paymentId, razorpayRefundId: refund.refundId },
        }),
      )
    }

    // Release for the session-complete mandate — a cancelled booking's
    // session will never complete, so nothing is left owing against it.
    // Skipped in the ₹0 edge case (never authorised) or if it already
    // lapsed on its own.
    if (fresh.sessionCompleteAuthorizationId && fresh.sessionCompleteAuthorizationExpiresAt && !fresh.sessionCompleteAuthorizationLapsedAt) {
      events.push(
        createSessionCompleteAuthorizationReleasedEvent(cmd.bookingId, ++sequence, deps.clock, {
          authorizationId: fresh.sessionCompleteAuthorizationId,
          rail: deps.paymentRail.name,
          expiresAt: fresh.sessionCompleteAuthorizationExpiresAt,
        }),
      )
    }

    const projection: BookingSnapshot = {
      ...fresh,
      status: 'CANCELLED_BY_CUSTOMER',
      sessionCompleteAuthorizationId: undefined,
      lastEventSequence: sequence,
    }
    await tx.append(events, projection, deps.merchantId)
  })

  const result: CancelBookingResult = {
    bookingId: cmd.bookingId,
    status: 'CANCELLED_BY_CUSTOMER',
    retained: { amountPaise: retainedAmount },
    refund: { refundId: refund?.refundId, amountPaise: refundAmount },
  }
  await deps.idempotencyStore.put('cancel', cmd.idempotencyKey, result)
  return result
}
