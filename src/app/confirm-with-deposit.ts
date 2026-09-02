import {
  createBookingConfirmedEvent,
  createDepositCapturedEvent,
  createPaymentRequestedEvent,
  createPolicyAcknowledgedEvent,
  createSessionCompleteAuthorizationHeldEvent,
} from '../domain/event-factory.js'
import type { BookingEvent, DepositCapturedEvent, PaymentRequestedLeg } from '../domain/events.js'
import { subtractPaise, toPaise, type Paise } from '../domain/money.js'
import type { Policy } from '../domain/policy.js'
import { Refusal, type RefusalCode } from '../domain/refusals.js'
import type { ServiceRecord } from '../ports/catalog-repo.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { NoActivePolicyError } from './get-policy.js'
import { executePaymentCall } from './payment-circuit-breaker.js'
import { appendRefusalEvent, refuseAgainstBooking } from './refusal.js'
import { ownedByMerchant } from './tenant-guard.js'
import type { AppDeps } from './types.js'

/**
 * How long a caller waits for a *concurrent* identical retry to finish
 * before giving up and treating it as `IDEMPOTENT_REPLAY` — dev-logs/013.
 * Generous because the winner of a claim can legitimately be mid-network-call
 * to the payment rail (`ensureDepositOrder`/`pollDepositCapture` and their
 * authorization-leg twins) when a second identical request arrives.
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
 * hold a real lock/connection across the payment call itself.
 *
 * Payment-link feature (dev-logs entry for this slice): this window now also
 * *is* the timeout mechanism a human has to actually pay. `confirm_with_deposit`
 * no longer blocks for minutes inside one call polling for a payment to land
 * — it does a short poll, and if nothing has landed yet, returns `PENDING`
 * with a pay link and this window keeps extending on each retry. If the
 * human never pays and the agent never retries, this window eventually
 * lapses and the existing hold-expiry worker reclaims the row exactly as it
 * always has — the same "leaves it HELD, never refused" invariant the old
 * in-process poll timeout used to guarantee, now enforced by infrastructure
 * that was already built and tested rather than a bespoke `while` loop.
 */
const CONFIRMATION_CLAIM_WINDOW_MS = 5 * 60 * 1000

/** Local-dev fallback only — every real entrypoint sets `AppDeps.payPageBaseUrl` from `PAY_PAGE_BASE_URL` (`build-deps.ts`). */
const DEFAULT_PAY_PAGE_BASE_URL = 'http://localhost:4002'

/**
 * Distinct from `cmd.idempotencyKey`, which keys the deposit leg (and, via
 * this suffix, the receipt Razorpay would otherwise collide on): two
 * separate Checkout completions can happen at `confirm_with_deposit` —
 * deposit capture and the session-complete mandate — and
 * `ManualCaptureRail`/`RazorpayPaymentProvider` both derive a Razorpay
 * `receipt` deterministically from whatever key they're given (dev-logs/006).
 * Reusing the same raw key across legs would make them resolve to the same
 * receipt and one call would find another's order. The deposit leg's key is
 * left untouched (not suffixed) because existing fixtures reference it as a
 * raw receipt string. (Used to take a third `'no_show_auth'` variant too —
 * removed along with the no-show feature.)
 */
function authorizationIdempotencyKey(depositIdempotencyKey: string, leg: 'session_complete_auth'): string {
  return `${depositIdempotencyKey}:${leg}`
}

/** ₹300, not ₹300.00 — trims the fraction only when the amount is a whole number of rupees. */
function formatRupees(paise: Paise): string {
  const rupees = paise / 100
  return `₹${Number.isInteger(rupees) ? rupees.toString() : rupees.toFixed(2)}`
}

/** The order already recorded for this leg on a prior `PENDING` round, if any — see the ensure-orders comment below for why a retry prefers this over asking the rail again. */
function knownPendingLeg(snapshot: BookingSnapshot, leg: PaymentRequestedLeg['leg']): { orderId: string; amountPaise: Paise } | undefined {
  const match = snapshot.pendingPaymentLegs?.find((l) => l.leg === leg)
  return match && { orderId: match.orderId, amountPaise: match.amountPaise }
}

/**
 * `'no_show_authorization'` is historical-only (see the no-show removal dev
 * log) — no live code path ever creates a leg with that value any more, but
 * the case stays so this switch remains exhaustive over `PaymentRequestedLeg['leg']`,
 * which still names it for the sake of any pre-removal `PENDING` round whose
 * `pendingPaymentLegs` this function might still be asked to label.
 */
export function legLabel(leg: PaymentRequestedLeg['leg'], amountPaise: Paise): string {
  switch (leg) {
    case 'deposit':
      return `${formatRupees(amountPaise)} deposit for your booking`
    case 'no_show_authorization':
      return `${formatRupees(amountPaise)} no-show hold — only charged if you miss your appointment`
    case 'session_complete_authorization':
      return `${formatRupees(amountPaise)} remaining-balance hold — charged after your appointment is marked complete`
  }
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

/** One still-outstanding leg, as returned to the calling agent — see `ConfirmWithDepositResult`'s `PENDING` variant. */
export interface OutstandingPaymentLeg {
  leg: PaymentRequestedLeg['leg']
  /** A short, human-readable description an agent can relay directly — "₹300 deposit for your booking." */
  label: string
  amountPaise: number
}

/**
 * `confirm_with_deposit` — the one tool in this slice that moves money.
 * Gate (docs §3 table): live unexpired hold AND policy acknowledged.
 * docs §7 Race 2: the hold-liveness check happens under `SELECT ... FOR
 * UPDATE`, re-read inside the lock, never before it — that's `transaction`
 * + `loadSnapshotForUpdate` below. See dev-logs/004 for why the payment
 * call itself happens *outside* that lock, in a second transaction.
 *
 * Payment-link feature (dev-logs entry for this slice), extended in the
 * follow-up covering one combined pay page and an optional deposit: which
 * legs even apply depends on the merchant's policy — `deposit` only if
 * `policy.depositAmountPaise` is set, `session_complete_authorization` only
 * if the service's price exceeds the deposit. A `CONFIRMED` result means every
 * *applicable* leg landed. A `PENDING` result means at least one applicable
 * leg's order exists but hasn't resolved yet — it carries a single `payUrl`
 * (one page handles every applicable leg, not one link per leg) and lists
 * which legs are still `outstanding`, and the booking stays `HELD`,
 * unchanged — see `docs/03-domain-model.md` §3, `PENDING` is a result
 * shape, never a booking status. Call again with the *same*
 * `idempotencyKey` once the human says they've paid (or just to check) — a
 * cheap, short-poll re-check against whichever orders already exist, not a
 * re-charge. What changed in this follow-up: an *optional* leg's order
 * simply existing and not yet having a payment on it — no error, nobody's
 * paid yet — now blocks `CONFIRMED` too, the same way the deposit already
 * did, instead of silently confirming without it. A genuine error checking
 * an *optional* leg (a decline, a rail fault) is still forgiven exactly as
 * dev-logs/028 established — confirms without it rather than waiting on an
 * outage forever. The deposit leg is the one exception throughout: an
 * actual decline or rail fault on the deposit specifically still rejects
 * immediately, unchanged, since there is nothing captured yet to protect by
 * waiting instead.
 */
export type ConfirmWithDepositResult =
  | {
      bookingId: string
      status: 'CONFIRMED'
      policyVersion: number
      /** `undefined` when this policy has no deposit configured at all. */
      deposit: { paymentId: string; amountPaise: number } | undefined
      /** The session-complete mandate — `service.pricePaise - (policy.depositAmountPaise ?? 0)`, captured when the merchant marks the session complete. `undefined` when the service's price exactly equals the deposit. */
      sessionCompleteMandate: { authorizationId: string; amountPaise: number; expiresAt: string } | undefined
    }
  | {
      bookingId: string
      status: 'PENDING'
      policyVersion: number
      /** One page, covers every applicable leg — hand this to the human. */
      payUrl: string
      /** Whichever applicable legs are still outstanding this round. */
      outstanding: readonly OutstandingPaymentLeg[]
    }

export class BookingNotFoundError extends Error {}

type GateOutcome =
  | { kind: 'ok'; snapshot: BookingSnapshot; policy: Policy; service: ServiceRecord }
  | { kind: 'refused'; code: RefusalCode; reason: string }
  | { kind: 'already_confirmed'; snapshot: BookingSnapshot }
  | { kind: 'not_found' }

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
    const result = await confirmWithDepositClaimed(cmd, deps)
    if (result.status === 'CONFIRMED') {
      await deps.idempotencyStore.put('confirm_with_deposit', cmd.idempotencyKey, result)
    } else {
      // PENDING is not a cacheable terminal outcome — release the claim so a
      // retry with the same key re-polls instead of replaying a stale result.
      await deps.idempotencyStore.release('confirm_with_deposit', cmd.idempotencyKey)
    }
    return result
  } catch (err) {
    await deps.idempotencyStore.release('confirm_with_deposit', cmd.idempotencyKey)
    throw err
  }
}

/**
 * Reconstructs the `CONFIRMED` result for a booking the gate found already
 * settled out from under this call — see the `already_confirmed` gate
 * outcome above. `BookingSnapshot` itself only carries the session-complete
 * mandate's fields (`confirmWithDepositClaimed`'s own finalize projection);
 * the deposit has no projected field at all, so it's read off the trail's
 * own `DEPOSIT_CAPTURED` event, the same place `cancel-booking.ts` reads it
 * from for the same reason.
 */
async function buildConfirmedResultFromSettledBooking(snapshot: BookingSnapshot, deps: AppDeps): Promise<ConfirmWithDepositResult> {
  if (snapshot.policyVersion === undefined) {
    throw new Error(`confirm_with_deposit: booking ${snapshot.bookingId} is CONFIRMED but has no recorded policyVersion — should be structurally impossible`)
  }

  const history = await deps.eventStore.loadEvents(snapshot.bookingId)
  const depositEvent = [...history].reverse().find((e): e is DepositCapturedEvent => e.type === 'DEPOSIT_CAPTURED')
  if (depositEvent && !depositEvent.authority.razorpayPaymentId) {
    throw new Error(`confirm_with_deposit: DEPOSIT_CAPTURED for ${snapshot.bookingId} has no razorpayPaymentId — should be structurally impossible`)
  }

  const hasSessionCompleteMandate =
    snapshot.sessionCompleteAuthorizationId !== undefined &&
    snapshot.sessionCompleteAuthorizationAmountPaise !== undefined &&
    snapshot.sessionCompleteAuthorizationExpiresAt !== undefined

  return {
    bookingId: snapshot.bookingId,
    status: 'CONFIRMED',
    policyVersion: snapshot.policyVersion,
    deposit: depositEvent ? { paymentId: depositEvent.authority.razorpayPaymentId!, amountPaise: depositEvent.action.amountPaise } : undefined,
    sessionCompleteMandate: hasSessionCompleteMandate
      ? {
          authorizationId: snapshot.sessionCompleteAuthorizationId!,
          amountPaise: snapshot.sessionCompleteAuthorizationAmountPaise!,
          expiresAt: snapshot.sessionCompleteAuthorizationExpiresAt!.toISOString(),
        }
      : undefined,
  }
}

async function confirmWithDepositClaimed(cmd: ConfirmWithDepositCommand, deps: AppDeps): Promise<ConfirmWithDepositResult> {
  const policy = await deps.catalogRepo.getActivePolicy(deps.merchantId)
  if (!policy) {
    throw new NoActivePolicyError(`no active policy for merchant ${deps.merchantId}`)
  }
  const depositAmountPaise: Paise = policy.depositAmountPaise ?? toPaise(0)

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
      // A webhook-driven finalize (`finalize-from-webhook.ts`, dev-logs/031)
      // can confirm this exact booking between this call and an earlier one
      // that returned PENDING for the same idempotencyKey — real money
      // already moved, under a different idempotency key (the webhook's
      // own), so the claim cache above never caught it. HOLD_EXPIRED means
      // "nothing happened, retry or give up"; here something very much did,
      // so replay the now-settled outcome instead of refusing it.
      if (snapshot.status === 'CONFIRMED') {
        return { kind: 'already_confirmed', snapshot }
      }
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
    if (service.pricePaise < depositAmountPaise) {
      return refuse(
        'SERVICE_PRICE_BELOW_DEPOSIT',
        `service ${service.serviceId}'s current price (${service.pricePaise}) is less than the deposit (${depositAmountPaise}) — the session-complete mandate would be negative`,
      )
    }

    // Claim this hold against the background expiry sweep for the duration
    // of the payment calls that follow — see CONFIRMATION_CLAIM_WINDOW_MS.
    // POLICY_ACKNOWLEDGED moves here (was previously written in the final
    // transaction, alongside the money events) purely so this write has a
    // real event to carry the bumped `holdExpiresAt` on the projection —
    // it doesn't depend on the payment result, so nothing is lost by
    // recording it earlier. A retried confirm attempt (same idempotencyKey,
    // still not paid) re-runs this gate and re-extends the window — the
    // repeated POLICY_ACKNOWLEDGED events are an honest record of "the gate
    // was re-verified at this time," not noise.
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
  if (gateOutcome.kind === 'already_confirmed') {
    return buildConfirmedResultFromSettledBooking(gateOutcome.snapshot, deps)
  }

  const { snapshot, service } = gateOutcome
  const now = deps.clock.now()

  // service.pricePaise >= depositAmountPaise is already guaranteed by the
  // gate above (SERVICE_PRICE_BELOW_DEPOSIT). Zero is a legitimate result —
  // a service priced exactly at the deposit (or a merchant running with no
  // deposit and a free service, degenerate but valid) has nothing left to
  // authorise — handled the same way cancel_booking already handles a ₹0
  // refund: skip the rail call entirely rather than authorise nothing.
  const sessionCompleteMandateAmountPaise: Paise = subtractPaise(service.pricePaise, depositAmountPaise)
  const needsDeposit = policy.depositAmountPaise !== undefined
  const needsSessionCompleteAuth = sessionCompleteMandateAmountPaise !== 0

  // Outside the row lock, deliberately — never hold a DB lock across a
  // network call to the payment rail. Two phases, run concurrently across
  // whichever legs actually apply via `allSettled`:
  //
  //  1. Ensure every applicable leg's order exists — fast, no waiting. This
  //     is what makes a pay link possible at all: `orderId` is known the
  //     instant the order is created, long before anyone has paid it. A
  //     retry (this booking already has `pendingPaymentLegs` from an earlier
  //     `PAYMENT_REQUESTED`) skips the rail call entirely and reuses the
  //     recorded orderId — a live test against real Razorpay found its own
  //     receipt-based order lookup is not immediately consistent (a few
  //     seconds' lag), so re-deriving the order via a fresh lookup on every
  //     retry risked creating a *second* order for the same leg. Our own
  //     projection is strongly consistent and is the better source of truth
  //     here regardless.
  //  2. A short poll per leg, catching a payer who was already mid-Checkout
  //     (typically: this is a retry after the human said "I've paid").
  //
  // Only an order-creation failure for a leg that's actually needed is
  // fatal — nothing was captured/authorised for it, nothing to record, and
  // there is no orderId to offer a link against, so the whole attempt
  // rethrows and the booking stays HELD for the agent to retry. This now
  // applies uniformly to every applicable leg, not just the deposit — see
  // this function's own doc comment for why an already-*resolved* leg is
  // still protected the same way dev-logs/028 originally protected the
  // deposit specifically.
  const knownDepositOrder = needsDeposit ? knownPendingLeg(snapshot, 'deposit') : undefined
  const knownSessionCompleteOrder = needsSessionCompleteAuth ? knownPendingLeg(snapshot, 'session_complete_authorization') : undefined

  const [depositOrderOutcome, sessionCompleteOrderOutcome] = await Promise.allSettled([
    !needsDeposit
      ? Promise.resolve(undefined)
      : knownDepositOrder
        ? Promise.resolve(knownDepositOrder)
        : executePaymentCall(deps.paymentCircuitBreaker, () =>
            deps.paymentProvider.ensureDepositOrder({ amountPaise: depositAmountPaise, idempotencyKey: cmd.idempotencyKey, reference: snapshot.bookingId }),
          ),
    !needsSessionCompleteAuth
      ? Promise.resolve(undefined)
      : knownSessionCompleteOrder
        ? Promise.resolve(knownSessionCompleteOrder)
        : executePaymentCall(deps.paymentCircuitBreaker, () =>
            deps.paymentRail.ensureAuthorizationOrder({
              amountPaise: sessionCompleteMandateAmountPaise,
              idempotencyKey: authorizationIdempotencyKey(cmd.idempotencyKey, 'session_complete_auth'),
              reference: snapshot.bookingId,
              now,
            }),
        ),
  ])

  // Only the deposit's order-creation failure is fatal — nothing captured,
  // nothing to protect, so there's no reason not to fail loudly and let the
  // agent retry. The session-complete leg's order-creation failure stays
  // forgiven here exactly as dev-logs/028 established for its poll — logged,
  // no link offered for it this round, but it never blocks the deposit from
  // proceeding. Unlike a poll failure (see below), this can't later show up
  // as "outstanding," since without an orderId there's nothing to build a
  // link or check status against at all.
  if (needsDeposit && depositOrderOutcome.status === 'rejected') {
    throw depositOrderOutcome.reason
  }
  const depositOrder = depositOrderOutcome.status === 'fulfilled' ? depositOrderOutcome.value : undefined
  const sessionCompleteOrder = sessionCompleteOrderOutcome.status === 'fulfilled' ? sessionCompleteOrderOutcome.value : undefined
  if (needsSessionCompleteAuth && sessionCompleteOrderOutcome.status === 'rejected') {
    deps.logger.error(
      { err: sessionCompleteOrderOutcome.reason, bookingId: snapshot.bookingId },
      'confirm_with_deposit: could not create the session-complete authorization order — confirming without this leg rather than waiting on it forever',
    )
  }

  // Phase 2: poll whichever orders exist. The deposit poll *rejecting* here
  // (a real decline, or a rail fault) is still a hard, immediate failure,
  // unchanged from before this follow-up — nothing was captured, so the
  // booking stays HELD and the agent sees a real error, not a silent
  // PENDING. An *optional* leg's poll rejecting stays forgiven exactly as
  // dev-logs/028 established (log it, don't let it block confirmation) —
  // that protects an already-captured deposit from being stranded by an
  // unrelated leg's genuine outage, and nothing about this follow-up
  // reopens it. What *is* new: an optional leg's order existing but simply
  // not yet paid — poll *fulfils* with `undefined`, no error at all — now
  // also blocks confirmation, the same way it already did for the deposit.
  // Before this follow-up that state couldn't arise for an optional leg (the
  // old blocking `authorize()` either returned a real result or timed out as
  // a rejection); now that polling is a first-class "maybe nothing yet, no
  // error" result, treating it as "keep waiting" rather than "silently
  // confirm without this leg" is what makes "deposit paid, session-complete
  // hold still outstanding — wait for it" actually true.
  const [depositPollOutcome, sessionCompletePollOutcome] = await Promise.allSettled([
    depositOrder === undefined ? Promise.resolve(undefined) : executePaymentCall(deps.paymentCircuitBreaker, () => deps.paymentProvider.pollDepositCapture(depositOrder, snapshot.bookingId)),
    sessionCompleteOrder === undefined
      ? Promise.resolve(undefined)
      : executePaymentCall(deps.paymentCircuitBreaker, () => deps.paymentRail.pollAuthorization(sessionCompleteOrder, snapshot.bookingId, now)),
  ])

  if (needsDeposit && depositPollOutcome.status === 'rejected') {
    throw depositPollOutcome.reason
  }
  const captured = depositPollOutcome.status === 'fulfilled' ? depositPollOutcome.value : undefined

  const sessionCompleteAuthorized = sessionCompletePollOutcome.status === 'fulfilled' ? sessionCompletePollOutcome.value : undefined
  if (sessionCompletePollOutcome.status === 'rejected') {
    deps.logger.error(
      { err: sessionCompletePollOutcome.reason, bookingId: snapshot.bookingId },
      'confirm_with_deposit: checking the session-complete authorization order failed — confirming without this leg rather than waiting on it forever',
    )
  }

  // Outstanding = the order exists and the poll cleanly found nothing yet
  // (fulfilled, undefined). A *rejected* poll on the optional leg is not
  // outstanding — it's forgiven, per the comment above.
  const depositOutstanding = depositOrder !== undefined && captured === undefined
  const sessionCompleteOutstanding = sessionCompleteOrder !== undefined && sessionCompletePollOutcome.status === 'fulfilled' && sessionCompleteAuthorized === undefined

  if (depositOutstanding || sessionCompleteOutstanding) {
    const allLegs: { leg: PaymentRequestedLeg['leg']; orderId: string; amountPaise: Paise }[] = []
    if (depositOrder) allLegs.push({ leg: 'deposit', orderId: depositOrder.orderId, amountPaise: depositOrder.amountPaise })
    if (sessionCompleteOrder) allLegs.push({ leg: 'session_complete_authorization', orderId: sessionCompleteOrder.orderId, amountPaise: sessionCompleteOrder.amountPaise })

    const outstandingLegs = new Set<PaymentRequestedLeg['leg']>()
    if (depositOutstanding) outstandingLegs.add('deposit')
    if (sessionCompleteOutstanding) outstandingLegs.add('session_complete_authorization')

    return recordPaymentRequested({ deps, snapshot, policy, allLegs, outstandingLegs })
  }

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
    const events: BookingEvent[] = []

    if (needsDeposit && captured !== undefined) {
      events.push(
        createDepositCapturedEvent(snapshot.bookingId, ++sequence, deps.clock, {
          action: { direction: 'credit', amountPaise: captured.amountPaise, instrument: captured.instrument },
          gate: {
            cleared: ['live_hold', 'policy_acked'],
            evidence: { holdExpiresAt: snapshot.holdExpiresAt?.toISOString(), policyVersion: policy.policyVersion },
          },
          bound: {
            ceilingPaise: depositAmountPaise,
            enforcedBy: 'latch_policy',
            headroomAfterPaise: subtractPaise(depositAmountPaise, captured.amountPaise),
          },
          authority: { policyVersion: policy.policyVersion, razorpayPaymentId: captured.paymentId },
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
      sessionCompleteAuthorizationId: sessionCompleteAuthorized?.authorizationId,
      sessionCompleteAuthorizationAmountPaise: sessionCompleteAuthorized?.amountPaise,
      sessionCompleteAuthorizationExpiresAt: sessionCompleteAuthorized?.expiresAt,
      // Nothing left pending — a link issued on an earlier PENDING round
      // (if any) should 404 from here on, not keep resolving.
      pendingPaymentLegs: undefined,
      lastEventSequence: sequence,
    }

    await tx.append(events, projection, deps.merchantId)
  })

  return {
    bookingId: snapshot.bookingId,
    status: 'CONFIRMED',
    policyVersion: policy.policyVersion,
    deposit: needsDeposit && captured !== undefined ? { paymentId: captured.paymentId, amountPaise: captured.amountPaise } : undefined,
    sessionCompleteMandate: sessionCompleteAuthorized && {
      authorizationId: sessionCompleteAuthorized.authorizationId,
      amountPaise: sessionCompleteAuthorized.amountPaise,
      expiresAt: sessionCompleteAuthorized.expiresAt.toISOString(),
    },
  }
}

/**
 * At least one applicable leg isn't resolved yet. Records `PAYMENT_REQUESTED`
 * (informational — see that event's own doc comment) so the trail explains
 * the otherwise unaccounted-for gap until the final finalize transaction
 * lands, persists *every* applicable leg (done or not — the `/pay` page
 * needs the full set to render per-leg status on one page, not just what's
 * still outstanding) onto the projection, and returns one combined `payUrl`
 * plus whichever legs are actually still outstanding. The booking stays
 * `HELD` — no status change, no new terminal state (docs/03-domain-model.md
 * §3: `PENDING` is a result shape, not a booking status).
 */
async function recordPaymentRequested(args: {
  deps: AppDeps
  snapshot: BookingSnapshot
  policy: Policy
  allLegs: readonly { leg: PaymentRequestedLeg['leg']; orderId: string; amountPaise: Paise }[]
  outstandingLegs: ReadonlySet<PaymentRequestedLeg['leg']>
}): Promise<ConfirmWithDepositResult> {
  const { deps, snapshot, policy, allLegs, outstandingLegs } = args

  const legs: PaymentRequestedLeg[] = allLegs.map((l) => ({ leg: l.leg, orderId: l.orderId, amountPaise: l.amountPaise, label: legLabel(l.leg, l.amountPaise) }))

  await deps.eventStore.transaction(async (tx) => {
    const fresh = await tx.loadSnapshotForUpdate(snapshot.bookingId)
    const base = fresh ?? snapshot
    if (base.status !== 'HELD') {
      throw new Error(
        `confirm_with_deposit: booking ${snapshot.bookingId} left the HELD state (now ${base.status}) while payment links were being issued — this should be structurally impossible under the confirmation claim window`,
      )
    }
    const sequence = base.lastEventSequence + 1
    const event = createPaymentRequestedEvent(snapshot.bookingId, sequence, deps.clock, { legs })
    const projection: BookingSnapshot = { ...base, pendingPaymentLegs: legs, lastEventSequence: sequence }
    await tx.append([event], projection, deps.merchantId)
  })

  const baseUrl = deps.payPageBaseUrl ?? DEFAULT_PAY_PAGE_BASE_URL
  return {
    bookingId: snapshot.bookingId,
    status: 'PENDING',
    policyVersion: policy.policyVersion,
    payUrl: `${baseUrl}/pay/${snapshot.bookingId}`,
    outstanding: legs.filter((l) => outstandingLegs.has(l.leg)).map((l) => ({ leg: l.leg, label: l.label, amountPaise: l.amountPaise })),
  }
}
