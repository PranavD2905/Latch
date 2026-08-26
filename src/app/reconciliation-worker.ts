import { mapWithConcurrency } from './concurrency.js'
import { RECONCILIATION_BATCH_SIZE, appendReconciliationFindings, detectKnownReferenceMismatches } from './reconciliation.js'
import type { AppDeps } from './types.js'

export interface ReconciliationWorkerResult {
  mismatchedBookingIds: readonly string[]
}

/**
 * Bounds how many candidates this worker checks against Razorpay
 * concurrently, on one tick. A plain `for` loop over `RECONCILIATION_BATCH_SIZE`
 * (50) candidates, each awaiting a real network call before starting the
 * next, makes a tick's wall-clock cost scale linearly with confirmed-booking
 * volume — fine at buildathon scale, the first thing to fall behind the
 * 60s tick cadence at real volume. Unbounded `Promise.all` over the whole
 * batch is the wrong fix in the other direction: it turns "up to 50
 * candidates" into "up to 50 concurrent Razorpay requests from one process,
 * every tick," which is how a legitimate reconciliation pass gets treated as
 * abuse by the payment provider's own rate limiter. A bounded pool is the
 * standard middle ground.
 */
const RECONCILIATION_CONCURRENCY = 8

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

  const results = await mapWithConcurrency(candidates, RECONCILIATION_CONCURRENCY, async (candidate) => {
    const history = await deps.eventStore.loadEvents(candidate.bookingId)
    const findings = await detectKnownReferenceMismatches(candidate, history, deps)
    if (findings.length === 0) return undefined

    const appended = await appendReconciliationFindings(candidate.bookingId, findings, 'periodic_worker', deps)
    return appended ? candidate.bookingId : undefined
  })

  const mismatchedBookingIds = results.filter((id): id is string => id !== undefined)
  return { mismatchedBookingIds }
}
