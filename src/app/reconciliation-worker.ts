import { RECONCILIATION_BATCH_SIZE, appendReconciliationFindings, detectKnownReferenceMismatches } from './reconciliation.js'
import type { AppDeps } from './types.js'

export interface ReconciliationWorkerResult {
  mismatchedBookingIds: readonly string[]
}

/**
 * dev-logs/014, item 1 — the periodic half of closing gap 1, a Razorpay
 * senior-SDE code review's finding: "the trail is the truth" was internally
 * consistent but never externally verified. If the response from Razorpay to
 * Latch's own server were ever lost (crash, network partition) after a
 * capture actually succeeded at Razorpay, no event would ever land in the
 * trail, and nothing would notice — the exact failure shape `get_booking`
 * already exists to cover one hop closer in (dev-logs/012's `mcp-remote`
 * timeout). This worker is what makes the *outer* hop self-correcting too:
 * it periodically asks Razorpay directly whether what the trail claims still
 * matches reality, upgrading "the trail is the truth" from an internally
 * consistent claim to an externally verified one.
 *
 * Reuses the existing `PaymentProvider`/`PaymentRail` ports exactly as
 * instructed — no new outbound integration, just the two new read-only
 * methods those ports gained (`fetchPaymentStatus`/`fetchAuthorizationStatus`)
 * and no new inbound surface at all.
 *
 * Same shape as `hold-expiry-worker.ts`/`authorization-lapse-worker.ts`:
 * read candidates, do the network call (a real Razorpay lookup) strictly
 * outside any DB lock (dev-logs/004 — never hold a row lock across a network
 * call), then re-lock each candidate individually before appending — the
 * same two-transaction discipline `confirm_with_deposit`/`decline_booking`
 * already use around a real Razorpay call. `POST /webhooks/razorpay`
 * (`src/adapters/merchant-api/server.ts`) is the real-time twin of this same
 * check, triggered by Razorpay's own delivery instead of a poll — see
 * `reconciliation.ts`'s `reconcileObservedPayment`.
 */
export async function runReconciliationWorker(deps: AppDeps): Promise<ReconciliationWorkerResult> {
  const candidates = await deps.eventStore.listOpenBookingsForReconciliation(RECONCILIATION_BATCH_SIZE)
  const mismatchedBookingIds: string[] = []

  for (const candidate of candidates) {
    const history = await deps.eventStore.loadEvents(candidate.bookingId)
    const findings = await detectKnownReferenceMismatches(candidate, history, deps)
    if (findings.length === 0) continue

    const appended = await appendReconciliationFindings(candidate.bookingId, findings, 'periodic_worker', deps)
    if (appended) mismatchedBookingIds.push(candidate.bookingId)
  }

  return { mismatchedBookingIds }
}
