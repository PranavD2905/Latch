import {
  createAuthorizationHeldEvent,
  createBookingConfirmedEvent,
  createDepositCapturedEvent,
  createPolicyAcknowledgedEvent,
  createSessionCompleteAuthorizationHeldEvent,
} from '../domain/event-factory.js'
import type { BookingEvent } from '../domain/events.js'
import { subtractPaise, toPaise, type Paise } from '../domain/money.js'
import type { Policy } from '../domain/policy.js'
import { Refusal, type RefusalCode } from '../domain/refusals.js'
import type { ServiceRecord } from '../ports/catalog-repo.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { NoActivePolicyError } from './get-policy.js'
import { appendRefusalEvent, refuseAgainstBooking } from './refusal.js'
import { ownedByMerchant } from './tenant-guard.js'
import type { AppDeps } from './types.js'

/**
 * Generous on purpose: `confirm_with_deposit` legitimately blocks on a human
 * completing real Razorpay Checkout, which routinely takes longer than a
 * minute (dev-logs/012's `mcp-remote` 60s-timeout incident). A concurrent
 * retry with the *same* idempotency key should wait for that human, not fail
 * fast — 5 minutes matches `DEFAULT_CAPTURE_TIMEOUT_MS`, the ceiling the
 * payment/rail adapters themselves already use for the same wait.
 */
const IDEMPOTENCY_CLAIM_TIMEOUT_MS = 5 * 60 * 1000

/**
 * dev-logs/013 (Slice 8, Race 2): the gate check and the money-moving append
 * are two separate transactions with a real, unlocked payment call between
 * them (see the big comment below for why that gap is deliberate). Without
 * this, a hold whose TTL happens to lapse *during* that payment call is
 * fair game for the background hold-expiry worker's sweep — and the final
 * append below, which didn't re-verify anything, would silently overwrite
 * that expiry back to CONFIRMED (or, worse, crash with an unhandled
 * unique-index violation if another agent had already re-claimed the freed
 * slot) *after* real money had already moved. The gate transaction now
 * extends `holdExpiresAt` into this window as part of its own write — the
 * worker's claim query (`holdExpiresAt < now`) then simply doesn't select
 * this row while a confirm is in flight, the same way `SKIP LOCKED` makes it
 * skip a row a concurrent transaction is holding, just without needing to
 * hold a real lock/connection across the payment call itself. Matches
 * `IDEMPOTENCY_CLAIM_TIMEOUT_MS` — both exist to cover the same worst case,
 * a human taking the full length of a real Checkout.
 */
const CONFIRMATION_CLAIM_WINDOW_MS = 5 * 60 * 1000

/**
 * Distinct from `cmd.idempotencyKey`, which keys the deposit leg (and, via
 * this suffix, the receipt Razorpay would otherwise collide on): up to three
 * separate Checkout completions can now happen at `confirm_with_deposit` —
 * deposit capture, no-show authorisation, and the session-complete mandate —
 * and `ManualCaptureRail`/`RazorpayPaymentProvider` both derive a Razorpay
 * `receipt` deterministically from whatever key they're given (dev-logs/006).
 * Reusing the same raw key across legs would make them resolve to the same
 * receipt and one call would find another's order. The deposit leg's key is
 * left untouched (not suffixed) because existing fixtures reference it as a
 * raw receipt string.
 */
function authorizationIdempotencyKey(depositIdempotencyKey: string, leg: 'no_show_auth' | 'session_complete_auth'): string {
  return `${depositIdempotencyKey}:${leg}`
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
  /** The no-show authorisation registered alongside the deposit — docs/01-architecture.md Idea 3. `undefined` when this policy has no no-show fee configured at all. */
  authorization: { authorizationId: string; amountPaise: number; expiresAt: string } | undefined
  /** The session-complete mandate — `service.pricePaise - policy.depositAmountPaise`, captured when the merchant marks the session complete. `undefined` only in the edge case where the service's price exactly equals the deposit (nothing left to authorise). */
  sessionCompleteMandate: { authorizationId: string; amountPaise: number; expiresAt: string } | undefined
}

export class BookingNotFoundError extends Error {}

type GateOutcome =
  | { kind: 'ok'; snapshot: BookingSnapshot; policy: Policy; service: ServiceRecord }
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
  const claim = await deps.idempotencyStore.claim<ConfirmWithDepositResult>('confirm_with_deposit', cmd.idempotencyKey, {
    timeoutMs: deps.idempotencyClaimTimeoutMs ?? IDEMPOTENCY_CLAIM_TIMEOUT_MS,
  })
  if (claim.kind === 'completed') {
    return claim.response
  }
  if (claim.kind === 'timed_out') {
    return refuseAgainstBooking(deps, cmd.bookingId, {
      attemptedType: 'confirm_with_deposit',
      code: 'IDEMPOTENT_REPLAY',
      reason: `a confirm_with_deposit request with idempotency key ${cmd.idempotencyKey} is already in progress and did not complete in time`,
    })
  }

  try {
    return await confirmWithDepositClaimed(cmd, deps)
  } catch (err) {
    await deps.idempotencyStore.release('confirm_with_deposit', cmd.idempotencyKey)
    throw err
  }
}

async function confirmWithDepositClaimed(cmd: ConfirmWithDepositCommand, deps: AppDeps): Promise<ConfirmWithDepositResult> {
  const policy = await deps.catalogRepo.getActivePolicy(deps.merchantId)
  if (!policy) {
    throw new NoActivePolicyError(`no active policy for merchant ${deps.merchantId}`)
  }

  const gateOutcome = await deps.eventStore.transaction<GateOutcome>(async (tx) => {
    const snapshot = ownedByMerchant(await tx.loadSnapshotForUpdate(cmd.bookingId), deps.merchantId)
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
        merchantId: deps.merchantId,
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

    // The service's *current* price, read fresh here rather than cached from
    // hold_slot time — a merchant editing a service's price between hold and
    // confirm is expected (this is a plain mutable column, `schema.ts`'s own
    // doc comment on `services.pricePaise`), and confirm is the one moment
    // that price gets frozen onto the booking via the session-complete
    // mandate below. `ownedByMerchant` here is defence in depth: `serviceId`
    // was already tenant-checked once, at hold_slot time.
    const service = ownedByMerchant(await deps.catalogRepo.getService(snapshot.serviceId), deps.merchantId)
    if (!service) {
      throw new Error(`confirm_with_deposit: booking ${snapshot.bookingId} references service ${snapshot.serviceId}, which no longer exists or changed owner — should be structurally impossible`)
    }
    if (service.pricePaise < policy.depositAmountPaise) {
      return refuse(
        'SERVICE_PRICE_BELOW_DEPOSIT',
        `service ${service.serviceId}'s current price (${service.pricePaise}) is less than the deposit (${policy.depositAmountPaise}) — the session-complete mandate would be negative`,
      )
    }

    // Claim this hold against the background expiry sweep for the duration
    // of the payment call that follows — see CONFIRMATION_CLAIM_WINDOW_MS.
    // POLICY_ACKNOWLEDGED moves here (was previously written in the final
    // transaction, alongside the money events) purely so this write has a
    // real event to carry the bumped `holdExpiresAt` on the projection —
    // it doesn't depend on the payment result, so nothing is lost by
    // recording it earlier.
    const ackEvent = createPolicyAcknowledgedEvent(snapshot.bookingId, nextSequence, deps.clock, {
      policyVersion: policy.policyVersion,
    })
    const claimedHoldExpiresAt = new Date(now.getTime() + CONFIRMATION_CLAIM_WINDOW_MS)
    const claimedSnapshot: BookingSnapshot = { ...snapshot, holdExpiresAt: claimedHoldExpiresAt, lastEventSequence: nextSequence }
    await tx.append([ackEvent], claimedSnapshot, deps.merchantId)

    // Return the *original* (unbumped) snapshot — callers below only use it
    // for its bookingId and the hold-expiry value to cite as gate evidence;
    // the claim-window bump is an internal detail of protecting the payment
    // call, not something the trail's own `gate.evidence` should surface.
    return { kind: 'ok', snapshot, policy, service }
  })

  if (gateOutcome.kind === 'not_found') {
    throw new BookingNotFoundError(`unknown booking: ${cmd.bookingId}`)
  }
  if (gateOutcome.kind === 'refused') {
    throw new Refusal(gateOutcome.code, gateOutcome.reason)
  }

  const { snapshot, service } = gateOutcome
  const now = deps.clock.now()

  // service.pricePaise >= policy.depositAmountPaise is already guaranteed by
  // the gate above (SERVICE_PRICE_BELOW_DEPOSIT). Zero is a legitimate
  // result — a service priced exactly at the deposit has nothing left to
  // authorise — and is handled the same way cancel_booking already handles a
  // ₹0 refund: skip the rail call entirely rather than authorise nothing.
  const sessionCompleteMandateAmountPaise: Paise = subtractPaise(service.pricePaise, policy.depositAmountPaise)

  // Outside the row lock, deliberately — never hold a DB lock across a
  // network call to the payment rail. A decline/timeout on any leg is an
  // external failure, not a gate/bound refusal, so no ACTION_REFUSED is
  // appended and the booking is left HELD: the agent can simply retry
  // confirm (its idempotency key was never stored, since we only store on
  // success). Run concurrently — docs/01-architecture.md Idea 3 / dev-logs/007:
  // up to three separate Checkout completions can exist in this build, so a
  // human waiting on them should not wait on them serially.
  const [captured, noShowAuthorized, sessionCompleteAuthorized] = await Promise.all([
    deps.paymentProvider.captureDeposit({
      amountPaise: policy.depositAmountPaise,
      idempotencyKey: cmd.idempotencyKey,
      reference: snapshot.bookingId,
    }),
    policy.noShowFeePaise === undefined
      ? Promise.resolve(undefined)
      : deps.paymentRail.authorize({
          amountPaise: policy.noShowFeePaise,
          idempotencyKey: authorizationIdempotencyKey(cmd.idempotencyKey, 'no_show_auth'),
          reference: snapshot.bookingId,
          now,
        }),
    sessionCompleteMandateAmountPaise === 0
      ? Promise.resolve(undefined)
      : deps.paymentRail.authorize({
          amountPaise: sessionCompleteMandateAmountPaise,
          idempotencyKey: authorizationIdempotencyKey(cmd.idempotencyKey, 'session_complete_auth'),
          reference: snapshot.bookingId,
          now,
        }),
  ])

  await deps.eventStore.transaction(async (tx) => {
    const fresh = await tx.loadSnapshotForUpdate(snapshot.bookingId)
    const base = fresh ?? snapshot

    // Belt and braces on top of the claim window above: the only actors
    // that can touch a HELD booking are this same confirm attempt and the
    // hold-expiry worker, and the claim window is specifically sized to
    // keep the worker off this row for the whole payment call. If this
    // ever fires, the claim mechanism itself has a bug — better to fail
    // loudly than silently overwrite whatever state this booking is
    // actually in with a CONFIRMED that real money was captured for, but
    // the trail can no longer honestly justify.
    if (base.status !== 'HELD') {
      throw new Error(
        `confirm_with_deposit: booking ${snapshot.bookingId} left the HELD state (now ${base.status}) while its deposit/authorization were being captured — this should be structurally impossible under the confirmation claim window`,
      )
    }

    let sequence = base.lastEventSequence

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
    const events: BookingEvent[] = [depositEvent]

    if (noShowAuthorized) {
      events.push(
        createAuthorizationHeldEvent(snapshot.bookingId, ++sequence, deps.clock, {
          authorizationId: noShowAuthorized.authorizationId,
          amountPaise: noShowAuthorized.amountPaise,
          expiresAt: noShowAuthorized.expiresAt,
          rail: deps.paymentRail.name,
          enforcedBy: 'payment_rail',
          policyVersion: policy.policyVersion,
        }),
      )
    }
    if (sessionCompleteAuthorized) {
      events.push(
        createSessionCompleteAuthorizationHeldEvent(snapshot.bookingId, ++sequence, deps.clock, {
          authorizationId: sessionCompleteAuthorized.authorizationId,
          amountPaise: sessionCompleteAuthorized.amountPaise,
          expiresAt: sessionCompleteAuthorized.expiresAt,
          rail: deps.paymentRail.name,
          enforcedBy: 'payment_rail',
          policyVersion: policy.policyVersion,
        }),
      )
    }
    events.push(createBookingConfirmedEvent(snapshot.bookingId, ++sequence, deps.clock, {}))

    const projection: BookingSnapshot = {
      ...base,
      status: 'CONFIRMED',
      policyVersion: policy.policyVersion,
      authorizationId: noShowAuthorized?.authorizationId,
      authorizationAmountPaise: noShowAuthorized?.amountPaise,
      authorizationExpiresAt: noShowAuthorized?.expiresAt,
      sessionCompleteAuthorizationId: sessionCompleteAuthorized?.authorizationId,
      sessionCompleteAuthorizationAmountPaise: sessionCompleteAuthorized?.amountPaise,
      sessionCompleteAuthorizationExpiresAt: sessionCompleteAuthorized?.expiresAt,
      lastEventSequence: sequence,
    }

    await tx.append(events, projection, deps.merchantId)
  })

  const result: ConfirmWithDepositResult = {
    bookingId: snapshot.bookingId,
    status: 'CONFIRMED',
    policyVersion: policy.policyVersion,
    deposit: { paymentId: captured.paymentId, amountPaise: captured.amountPaise },
    authorization: noShowAuthorized && { authorizationId: noShowAuthorized.authorizationId, amountPaise: noShowAuthorized.amountPaise, expiresAt: noShowAuthorized.expiresAt.toISOString() },
    sessionCompleteMandate: sessionCompleteAuthorized && {
      authorizationId: sessionCompleteAuthorized.authorizationId,
      amountPaise: sessionCompleteAuthorized.amountPaise,
      expiresAt: sessionCompleteAuthorized.expiresAt.toISOString(),
    },
  }
  await deps.idempotencyStore.put('confirm_with_deposit', cmd.idempotencyKey, result)
  return result
}
