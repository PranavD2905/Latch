import { createAuthorizationHeldEvent, createBookingConfirmedEvent, createDepositCapturedEvent, createPolicyAcknowledgedEvent } from '../domain/event-factory.js'
import { subtractPaise } from '../domain/money.js'
import type { Policy } from '../domain/policy.js'
import { Refusal, type RefusalCode } from '../domain/refusals.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { NoActivePolicyError } from './get-policy.js'
import { appendRefusalEvent } from './refusal.js'
import type { AppDeps } from './types.js'

/**
 * Distinct from `cmd.idempotencyKey`, which keys the deposit leg (and, via
 * this suffix, the receipt Razorpay would otherwise collide on): two
 * separate Checkout completions happen at `confirm_with_deposit` — deposit
 * capture and no-show authorisation — and `ManualCaptureRail`/
 * `RazorpayPaymentProvider` both derive a Razorpay `receipt` deterministically
 * from whatever key they're given (dev-logs/006). Reusing the same raw key
 * for both would make them resolve to the same receipt and one call would
 * find the other's order. The deposit leg's key is left untouched (not
 * suffixed) because existing fixtures reference it as a raw receipt string.
 */
function authorizationIdempotencyKey(depositIdempotencyKey: string): string {
  return `${depositIdempotencyKey}:no_show_auth`
}

export interface ConfirmWithDepositCommand {
  bookingId: string
  agentId: string
  /**
   * The agent must call `get_policy` first and echo back the version it
   * read and is acting under. There is no separate `acknowledge_policy`
   * tool in Slice 1's four-tool surface, so this doubles as that signal.
   * Absent/undefined -> `POLICY_NOT_ACKNOWLEDGED`. Present but not the
   * merchant's *current* version -> `POLICY_VERSION_STALE`.
   */
  acknowledgedPolicyVersion: number | undefined
  idempotencyKey: string
}

export interface ConfirmWithDepositResult {
  bookingId: string
  status: 'CONFIRMED'
  policyVersion: number
  deposit: {
    paymentId: string
    amountPaise: number
  }
  /** The no-show authorisation registered alongside the deposit — docs/01-architecture.md Idea 3. */
  authorization: {
    authorizationId: string
    amountPaise: number
    expiresAt: string
  }
}

export class BookingNotFoundError extends Error {}

type GateOutcome =
  | { kind: 'ok'; snapshot: BookingSnapshot; policy: Policy }
  | { kind: 'refused'; code: RefusalCode; reason: string }
  | { kind: 'not_found' }

/**
 * `confirm_with_deposit` — the one tool in this slice that moves money.
 * Gate (docs §3 table): live unexpired hold AND policy acknowledged.
 * docs §7 Race 2: the hold-liveness check happens under `SELECT ... FOR
 * UPDATE`, re-read inside the lock, never before it — that's `transaction`
 * + `loadSnapshotForUpdate` below. See dev-logs/004 for why the payment
 * call itself happens *outside* that lock, in a second transaction.
 */
export async function confirmWithDeposit(cmd: ConfirmWithDepositCommand, deps: AppDeps): Promise<ConfirmWithDepositResult> {
  const cached = await deps.idempotencyStore.get<ConfirmWithDepositResult>('confirm_with_deposit', cmd.idempotencyKey)
  if (cached) {
    return cached
  }

  const policy = await deps.catalogRepo.getActivePolicy(deps.merchantId)
  if (!policy) {
    throw new NoActivePolicyError(`no active policy for merchant ${deps.merchantId}`)
  }

  const gateOutcome = await deps.eventStore.transaction<GateOutcome>(async (tx) => {
    const snapshot = await tx.loadSnapshotForUpdate(cmd.bookingId)
    if (!snapshot) {
      return { kind: 'not_found' }
    }

    const nextSequence = snapshot.lastEventSequence + 1
    const refuse = async (code: RefusalCode, reason: string): Promise<GateOutcome> => {
      await appendRefusalEvent({
        tx,
        clock: deps.clock,
        bookingId: snapshot.bookingId,
        sequence: nextSequence,
        attemptedType: 'confirm_with_deposit',
        code,
        reason,
        projection: { ...snapshot, lastEventSequence: nextSequence },
      })
      return { kind: 'refused', code, reason }
    }

    const now = deps.clock.now()
    const holdLive = snapshot.status === 'HELD' && snapshot.holdExpiresAt !== undefined && snapshot.holdExpiresAt.getTime() > now.getTime()
    if (!holdLive) {
      return refuse('HOLD_EXPIRED', `booking ${snapshot.bookingId} has no live, unexpired hold (status=${snapshot.status})`)
    }

    if (cmd.acknowledgedPolicyVersion === undefined) {
      return refuse('POLICY_NOT_ACKNOWLEDGED', 'confirm_with_deposit called without acknowledging the current policy — call get_policy first')
    }

    if (cmd.acknowledgedPolicyVersion !== policy.policyVersion) {
      return refuse(
        'POLICY_VERSION_STALE',
        `acknowledged policy v${cmd.acknowledgedPolicyVersion}, but the merchant's current policy is v${policy.policyVersion} — re-read and re-acknowledge`,
      )
    }

    return { kind: 'ok', snapshot, policy }
  })

  if (gateOutcome.kind === 'not_found') {
    throw new BookingNotFoundError(`unknown booking: ${cmd.bookingId}`)
  }
  if (gateOutcome.kind === 'refused') {
    throw new Refusal(gateOutcome.code, gateOutcome.reason)
  }

  const { snapshot } = gateOutcome
  const now = deps.clock.now()

  // Outside the row lock, deliberately — never hold a DB lock across a
  // network call to the payment rail. A decline/timeout on either leg is an
  // external failure, not a gate/bound refusal, so no ACTION_REFUSED is
  // appended and the booking is left HELD: the agent can simply retry
  // confirm (its idempotency key was never stored, since we only store on
  // success). Run concurrently — docs/01-architecture.md Idea 3 / dev-logs/007:
  // two separate Checkout completions in this build, so a human waiting on
  // both should not wait on them serially.
  const [captured, authorized] = await Promise.all([
    deps.paymentProvider.captureDeposit({
      amountPaise: policy.depositAmountPaise,
      idempotencyKey: cmd.idempotencyKey,
      reference: snapshot.bookingId,
    }),
    deps.paymentRail.authorize({
      amountPaise: policy.noShowFeePaise,
      idempotencyKey: authorizationIdempotencyKey(cmd.idempotencyKey),
      reference: snapshot.bookingId,
      now,
    }),
  ])

  await deps.eventStore.transaction(async (tx) => {
    const fresh = await tx.loadSnapshotForUpdate(snapshot.bookingId)
    const base = fresh ?? snapshot
    let sequence = base.lastEventSequence

    const ackEvent = createPolicyAcknowledgedEvent(snapshot.bookingId, ++sequence, deps.clock, {
      policyVersion: policy.policyVersion,
    })
    const depositEvent = createDepositCapturedEvent(snapshot.bookingId, ++sequence, deps.clock, {
      action: { direction: 'credit', amountPaise: captured.amountPaise, instrument: captured.instrument },
      gate: {
        cleared: ['live_hold', 'policy_acked'],
        evidence: { holdExpiresAt: snapshot.holdExpiresAt?.toISOString(), policyVersion: policy.policyVersion },
      },
      bound: {
        ceilingPaise: policy.depositAmountPaise,
        enforcedBy: 'latch_policy',
        headroomAfterPaise: subtractPaise(policy.depositAmountPaise, captured.amountPaise),
      },
      authority: { policyVersion: policy.policyVersion, razorpayPaymentId: captured.paymentId },
    })
    const authorizationEvent = createAuthorizationHeldEvent(snapshot.bookingId, ++sequence, deps.clock, {
      authorizationId: authorized.authorizationId,
      amountPaise: authorized.amountPaise,
      expiresAt: authorized.expiresAt,
      rail: deps.paymentRail.name,
      enforcedBy: 'payment_rail',
      policyVersion: policy.policyVersion,
    })
    const confirmedEvent = createBookingConfirmedEvent(snapshot.bookingId, ++sequence, deps.clock, {})

    const projection: BookingSnapshot = {
      ...base,
      status: 'CONFIRMED',
      policyVersion: policy.policyVersion,
      authorizationId: authorized.authorizationId,
      authorizationAmountPaise: authorized.amountPaise,
      authorizationExpiresAt: authorized.expiresAt,
      lastEventSequence: sequence,
    }

    await tx.append([ackEvent, depositEvent, authorizationEvent, confirmedEvent], projection)
  })

  const result: ConfirmWithDepositResult = {
    bookingId: snapshot.bookingId,
    status: 'CONFIRMED',
    policyVersion: policy.policyVersion,
    deposit: { paymentId: captured.paymentId, amountPaise: captured.amountPaise },
    authorization: { authorizationId: authorized.authorizationId, amountPaise: authorized.amountPaise, expiresAt: authorized.expiresAt.toISOString() },
  }
  await deps.idempotencyStore.put('confirm_with_deposit', cmd.idempotencyKey, result)
  return result
}
