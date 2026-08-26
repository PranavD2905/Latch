import {
  createAlternativesOfferedEvent,
  createAuthorizationReleasedEvent,
  createMerchantDeclinedEvent,
  createRefundIssuedEvent,
  createSlotReleasedEvent,
} from '../domain/event-factory.js'
import type { AuthorizationHeldEvent, DepositCapturedEvent } from '../domain/events.js'
import { subtractPaise } from '../domain/money.js'
import { findSlots } from './find-slots.js'
import { ownedByMerchant } from './tenant-guard.js'
import type { AppDeps } from './types.js'

export interface DeclineBookingCommand {
  bookingId: string
  /** Free text, e.g. "practitioner_unavailable". Recorded verbatim on MERCHANT_DECLINED. */
  reason: string
  idempotencyKey: string
}

export interface DeclineBookingResult {
  bookingId: string
  status: 'DECLINED_BY_MERCHANT'
  refund: { refundId: string; amountPaise: number }
  alternatives: readonly { practitionerId: string; serviceId: string; startsAt: string }[]
}

export class BookingNotFoundError extends Error {}
/** The booking exists but isn't in a state a decline can apply to — e.g. still HELD, or already terminal. */
export class BookingNotDeclinableError extends Error {}
/** A CONFIRMED booking with no DEPOSIT_CAPTURED event in its history would be a prior-slice bug, not a real state. */
export class NoDepositFoundError extends Error {}
/** A CONFIRMED booking with no AUTHORIZATION_HELD event in its history would be a prior-slice bug (every confirm_with_deposit registers one) — not a real state. */
export class NoAuthorizationFoundError extends Error {}

type GateOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_declinable' }
  | { kind: 'no_deposit' }
  | { kind: 'no_authorization' }
  | {
      kind: 'ok'
      practitionerId: string
      serviceId: string
      startsAt: Date
      policyVersion: number | undefined
      lastEventSequence: number
      deposit: DepositCapturedEvent
      authorization: AuthorizationHeldEvent
    }

/**
 * `decline_booking` — the merchant-only failure path, docs/01-architecture.md
 * §7 / docs/03-domain-model.md §3 Rule 2. Never reachable by an agent: this
 * function is not registered as an MCP tool (see src/adapters/mcp/server.ts)
 * and is only ever invoked from the merchant API
 * (src/adapters/merchant-api/), which gates on a merchant token before
 * calling it. `cause` is not a parameter here at all — the only caller of
 * this command is the merchant surface, so cause=MERCHANT is fixed by which
 * function you're even able to call, not by a value that could be passed
 * wrong. See MerchantDeclinedEvent's `cause: 'MERCHANT'` literal type.
 *
 * Follows the same two-transaction shape dev-logs/004 established for
 * confirm_with_deposit: gate-check under a row lock, network calls (the
 * real Razorpay refund, and a find_slots calendar query for alternatives)
 * strictly outside any lock, then all five trail events appended atomically
 * in one final transaction — all five or none.
 */
export async function declineBooking(cmd: DeclineBookingCommand, deps: AppDeps): Promise<DeclineBookingResult> {
  const cached = await deps.idempotencyStore.get<DeclineBookingResult>('decline_booking', cmd.idempotencyKey)
  if (cached) {
    return cached
  }

  const gateOutcome = await deps.eventStore.transaction<GateOutcome>(async (tx) => {
    const snapshot = ownedByMerchant(await tx.loadSnapshotForUpdate(cmd.bookingId), deps.merchantId)
    if (!snapshot) {
      return { kind: 'not_found' }
    }
    if (snapshot.status !== 'CONFIRMED') {
      return { kind: 'not_declinable' }
    }

    const history = await tx.loadEvents(cmd.bookingId)
    const deposit = history.find((e): e is DepositCapturedEvent => e.type === 'DEPOSIT_CAPTURED')
    if (!deposit) {
      return { kind: 'no_deposit' }
    }
    const authorization = history.find((e): e is AuthorizationHeldEvent => e.type === 'AUTHORIZATION_HELD')
    if (!authorization) {
      return { kind: 'no_authorization' }
    }

    return {
      kind: 'ok',
      practitionerId: snapshot.practitionerId,
      serviceId: snapshot.serviceId,
      startsAt: snapshot.startsAt,
      policyVersion: snapshot.policyVersion,
      lastEventSequence: snapshot.lastEventSequence,
      deposit,
      authorization,
    }
  })

  if (gateOutcome.kind === 'not_found') {
    throw new BookingNotFoundError(`unknown booking: ${cmd.bookingId}`)
  }
  if (gateOutcome.kind === 'not_declinable') {
    throw new BookingNotDeclinableError(`booking ${cmd.bookingId} is not CONFIRMED — only a confirmed booking can be declined`)
  }
  if (gateOutcome.kind === 'no_deposit') {
    throw new NoDepositFoundError(`booking ${cmd.bookingId} is CONFIRMED but has no DEPOSIT_CAPTURED event in its history`)
  }
  if (gateOutcome.kind === 'no_authorization') {
    throw new NoAuthorizationFoundError(`booking ${cmd.bookingId} is CONFIRMED but has no AUTHORIZATION_HELD event in its history`)
  }

  const { practitionerId, serviceId, startsAt, deposit, authorization } = gateOutcome

  const paymentId = deposit.authority.razorpayPaymentId
  if (!paymentId) {
    throw new NoDepositFoundError(`DEPOSIT_CAPTURED for ${cmd.bookingId} has no razorpayPaymentId — cannot refund`)
  }

  // Outside any DB lock, deliberately — same discipline as confirm_with_deposit
  // (dev-logs/004): never hold a row lock across a network call. Both of
  // these are reads/writes against outside systems, not the booking row.
  const refund = await deps.paymentProvider.refundDeposit({
    paymentId,
    amountPaise: deposit.action.amountPaise,
    idempotencyKey: cmd.idempotencyKey,
    reference: cmd.bookingId,
  })

  // ALTERNATIVES_OFFERED is a calendar query, not a model (docs/05-cost-model.md
  // §1 / slice-3.md item 4) — this literally reuses find_slots, then drops the
  // exact slot that was just declined so the practitioner's own unavailable
  // slot is never re-offered as an "alternative" to it.
  const found = await findSlots({ practitionerId, serviceId, days: undefined }, deps)
  const alternatives = found.slots
    .filter((iso) => iso !== startsAt.toISOString())
    .slice(0, 3)
    .map((iso) => ({ practitionerId, serviceId, startsAt: iso }))

  await deps.eventStore.transaction(async (tx) => {
    const fresh = await tx.loadSnapshotForUpdate(cmd.bookingId)
    if (!fresh) {
      throw new BookingNotFoundError(`booking ${cmd.bookingId} disappeared between the gate check and the decline write`)
    }
    let sequence = fresh.lastEventSequence

    const declinedEvent = createMerchantDeclinedEvent(cmd.bookingId, ++sequence, deps.clock, {
      reason: cmd.reason,
      cause: 'MERCHANT',
    })
    const slotReleasedEvent = createSlotReleasedEvent(cmd.bookingId, ++sequence, deps.clock, {
      practitionerId,
      startsAt,
    })
    const refundEvent = createRefundIssuedEvent(cmd.bookingId, ++sequence, deps.clock, {
      action: { direction: 'debit', amountPaise: refund.amountPaise, instrument: deposit.action.instrument },
      gate: {
        cleared: ['merchant_caused_cancellation'],
        evidence: { declinedReason: cmd.reason },
      },
      bound: {
        ceilingPaise: deposit.action.amountPaise,
        enforcedBy: 'latch_policy',
        headroomAfterPaise: subtractPaise(deposit.action.amountPaise, refund.amountPaise),
      },
      authority: {
        policyVersion: deposit.authority.policyVersion,
        razorpayPaymentId: paymentId,
        razorpayRefundId: refund.refundId,
      },
    })
    // No rail call here, deliberately (dev-logs/005: no void endpoint) —
    // "released" means we simply never call captureAuthorization on it.
    // Razorpay auto-refunds the authorisation on its own at `expiresAt`.
    const authorizationReleasedEvent = createAuthorizationReleasedEvent(cmd.bookingId, ++sequence, deps.clock, {
      authorizationId: authorization.authorizationId,
      rail: authorization.rail,
      expiresAt: authorization.expiresAt,
    })
    const alternativesEvent = createAlternativesOfferedEvent(cmd.bookingId, ++sequence, deps.clock, {
      alternatives: alternatives.map((a) => ({ ...a, startsAt: new Date(a.startsAt) })),
    })

    const projection = { ...fresh, status: 'DECLINED_BY_MERCHANT' as const, lastEventSequence: sequence }

    await tx.append([declinedEvent, slotReleasedEvent, refundEvent, authorizationReleasedEvent, alternativesEvent], projection, deps.merchantId)
  })

  const result: DeclineBookingResult = {
    bookingId: cmd.bookingId,
    status: 'DECLINED_BY_MERCHANT',
    refund: { refundId: refund.refundId, amountPaise: refund.amountPaise },
    alternatives,
  }
  await deps.idempotencyStore.put('decline_booking', cmd.idempotencyKey, result)
  return result
}
