import { createReconciliationMismatchEvent } from '../domain/event-factory.js'
import type { AuthorizationHeldEvent, BookingEvent, DepositCapturedEvent, ReconciliationMismatchEvent } from '../domain/events.js'
import type { Paise } from '../domain/money.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import type { AppDeps } from './types.js'

export const RECONCILIATION_BATCH_SIZE = 50

export interface Finding {
  subject: ReconciliationMismatchEvent['subject']
  razorpayId: string
  expectedStatus: string
  expectedAmountPaise: Paise | undefined
  actualStatus: string
  actualAmountPaise: Paise | undefined
}

/**
 * dev-logs/014, item 1's per-booking check — see `reconciliation-worker.ts`
 * for the periodic job that drives this over every open booking, and the
 * fuller explanation of why this exists and the two-transaction discipline
 * around it. Exported so the worker file can stay a thin, readable mirror of
 * `hold-expiry-worker.ts`/`authorization-lapse-worker.ts`'s own shape.
 */
export async function detectKnownReferenceMismatches(candidate: BookingSnapshot, history: readonly BookingEvent[], deps: AppDeps): Promise<Finding[]> {
  const findings: Finding[] = []

  const deposit = history.find((e): e is DepositCapturedEvent => e.type === 'DEPOSIT_CAPTURED')
  if (deposit?.authority.razorpayPaymentId) {
    const actual = await deps.reconciliationCircuitBreaker.execute(() => deps.paymentProvider.fetchPaymentStatus(deposit.authority.razorpayPaymentId!))
    if (actual.status !== 'unknown' && (actual.status !== 'captured' || actual.amountPaise !== deposit.action.amountPaise)) {
      findings.push({
        subject: 'deposit',
        razorpayId: deposit.authority.razorpayPaymentId,
        expectedStatus: 'captured',
        expectedAmountPaise: deposit.action.amountPaise,
        actualStatus: actual.status,
        actualAmountPaise: actual.amountPaise,
      })
    }
  }

  // A CONFIRMED booking's authorisation should still be sitting `authorized`
  // (uncaptured) — charge_no_show flips status away from CONFIRMED the
  // instant it captures, so this worker (scoped to CONFIRMED candidates)
  // never legitimately expects to see one already `captured`.
  if (candidate.authorizationId && candidate.authorizationAmountPaise !== undefined) {
    const actual = await deps.reconciliationCircuitBreaker.execute(() => deps.paymentRail.fetchAuthorizationStatus(candidate.authorizationId!))
    if (actual.status !== 'unknown' && (actual.status !== 'authorized' || actual.amountPaise !== candidate.authorizationAmountPaise)) {
      findings.push({
        subject: 'authorization',
        razorpayId: candidate.authorizationId,
        expectedStatus: 'authorized',
        expectedAmountPaise: candidate.authorizationAmountPaise,
        actualStatus: actual.status,
        actualAmountPaise: actual.amountPaise,
      })
    }
  }

  return findings
}

/**
 * dev-logs/014, item 2 — the real-time half, called from the webhook route
 * (`POST /webhooks/razorpay`) with exactly what Razorpay's own payload says
 * about one payment/authorisation, for one booking (resolved from the
 * order's `notes.bookingId` — see `razorpay-payment-provider.ts`/
 * `manual-capture-rail.ts`, which set it at order-creation time). Unlike the
 * periodic worker, this never has to *ask* Razorpay anything — the webhook
 * delivery already is the answer — so there is no unlocked network call to
 * keep outside a transaction here; the whole check is a local comparison
 * against the trail, appended with the same idempotent, dedup-aware helper
 * the periodic worker uses. This is what actually closes gap 1's worst case:
 * a booking still sitting HELD because Latch crashed between Razorpay
 * confirming a capture and Latch's own final transaction appending
 * `DEPOSIT_CAPTURED` — the webhook still arrives (Razorpay retries
 * deliveries), and finds real money moved with nothing in the trail to show
 * for it.
 */
export interface ObservedPayment {
  razorpayId: string
  status: 'captured' | 'authorized' | 'failed' | 'refunded'
  amountPaise: Paise
}

export async function reconcileObservedPayment(bookingId: string, observed: ObservedPayment, deps: AppDeps): Promise<{ mismatch: boolean }> {
  if (observed.status !== 'captured' && observed.status !== 'authorized') {
    // A failed/refunded observation isn't "money moved unexplained" by
    // itself — REFUND_ISSUED already exists as its own trail event when
    // *Latch* initiates a refund, and a failed attempt never moved money in
    // the first place. Scoped narrowly to the actual gap-1 shape.
    return { mismatch: false }
  }

  const history = await deps.eventStore.loadEvents(bookingId)
  if (history.length === 0) {
    // Unknown/ephemeral bookingId (e.g. a stray webhook for a booking this
    // deployment never created, or a pure-refusal record with no live
    // booking) — nothing to reconcile against.
    return { mismatch: false }
  }
  if (isRecordedAnywhere(history, observed.razorpayId)) {
    return { mismatch: false } // exactly what the trail already says — no-op.
  }

  const appended = await appendReconciliationFindings(
    bookingId,
    [
      {
        subject: 'unrecorded_payment',
        razorpayId: observed.razorpayId,
        expectedStatus: 'not_recorded',
        expectedAmountPaise: undefined,
        actualStatus: observed.status,
        actualAmountPaise: observed.amountPaise,
      },
    ],
    'webhook',
    deps,
  )
  return { mismatch: appended }
}

function isRecordedAnywhere(history: readonly BookingEvent[], razorpayId: string): boolean {
  return history.some((e) => {
    if (e.type === 'DEPOSIT_CAPTURED' || e.type === 'NO_SHOW_CHARGED') return e.authority.razorpayPaymentId === razorpayId
    if (e.type === 'AUTHORIZATION_HELD') return (e as AuthorizationHeldEvent).authorizationId === razorpayId
    return false
  })
}

/**
 * Shared append path for both callers above: re-locks the booking, re-reads
 * its history under that lock, drops any finding that would just repeat the
 * most recent recorded finding for the same subject+razorpayId (so a
 * persistent, unresolved mismatch is recorded once, not every tick — and
 * re-recorded only if the external state changes again), and appends
 * whatever's left. Never writes the projection's `status` — a
 * `RECONCILIATION_MISMATCH` reports a disagreement, it does not resolve one;
 * fixing it (if it's real) is a human/merchant action outside this system's
 * automated authority, same reasoning as every other `Nothing`-response
 * refusal in docs/03-domain-model.md §5.
 */
export async function appendReconciliationFindings(
  bookingId: string,
  findings: readonly Finding[],
  detectedVia: ReconciliationMismatchEvent['detectedVia'],
  deps: AppDeps,
): Promise<boolean> {
  return deps.eventStore.transaction(async (tx) => {
    const fresh = await tx.loadSnapshotForUpdate(bookingId)
    if (!fresh) return false

    const freshHistory = await tx.loadEvents(bookingId)
    const newFindings = findings.filter((f) => !isAlreadyRecorded(freshHistory, f))
    if (newFindings.length === 0) return false

    let sequence = fresh.lastEventSequence
    const events = newFindings.map((f) => createReconciliationMismatchEvent(bookingId, ++sequence, deps.clock, { ...f, detectedVia }))
    // The reconciliation worker scans across every merchant in one tick
    // (`reconciliation-worker.ts`'s own doc comment); the webhook path
    // (`reconcileObservedPayment`, above) resolves a booking purely by its
    // own id, with no merchant in the request at all. Either way,
    // `fresh.merchantId` — this booking's own recorded owner — is the only
    // correct merchant to stamp the finding with, never a caller-supplied
    // default.
    await tx.append(events, { ...fresh, lastEventSequence: sequence }, fresh.merchantId)
    return true
  })
}

function isAlreadyRecorded(history: readonly BookingEvent[], finding: Finding): boolean {
  const priorForSubject = [...history]
    .reverse()
    .find((e): e is ReconciliationMismatchEvent => e.type === 'RECONCILIATION_MISMATCH' && e.subject === finding.subject && e.razorpayId === finding.razorpayId)
  if (!priorForSubject) return false
  return priorForSubject.actualStatus === finding.actualStatus && priorForSubject.actualAmountPaise === finding.actualAmountPaise
}
