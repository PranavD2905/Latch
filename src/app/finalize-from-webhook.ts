import { confirmWithDeposit } from './confirm-with-deposit.js'
import type { AppDeps } from './types.js'

/**
 * Finalize a booking off the back of Razorpay's own webhook, rather than
 * waiting for the calling agent to retry `confirm_with_deposit`.
 *
 * ## Why this exists (dev-logs/031)
 *
 * `confirm_with_deposit` hands the customer up to three pay links, returns
 * `PENDING`, and leaves the booking `HELD` with a five-minute claim window
 * (`CONFIRMATION_CLAIM_WINDOW_MS`). Finalization then depended entirely on the
 * *agent* calling `confirm_with_deposit` again — which, per its tool
 * description, it only does once the user says they have paid.
 *
 * That made a financial outcome depend on a conversational one. Observed in
 * production: a customer paid all three legs (₹300 captured, ₹400 and ₹500
 * authorised), never got round to telling the agent, and the hold-expiry
 * worker reclaimed the slot five minutes later exactly as designed. Real money
 * sat at Razorpay against an `expired` booking with nothing in the trail
 * claiming it — the precise disaster reconciliation exists to shout about.
 *
 * The information needed to prevent it was already in hand: Razorpay's webhook
 * had told us the payment landed. We used that only to *suppress a
 * reconciliation alarm* and then discarded it.
 *
 * ## What this does
 *
 * On a payment landing against a leg this booking is still waiting on, it
 * re-enters `confirm_with_deposit` — the same path the agent's retry would
 * take, with no duplicated money logic. That single call does both jobs:
 *
 * - **All legs now complete** → it finalizes: deposit captured, authorisations
 *   held, `BOOKING_CONFIRMED`. The agent's later "did it work?" becomes a read
 *   of an already-settled booking.
 * - **Some legs still outstanding** → it returns `PENDING` again, which
 *   re-extends the claim window. A customer who is visibly still paying stops
 *   racing a five-minute clock they cannot see.
 *
 * ## Why re-entering with a different idempotency key is safe
 *
 * The key seeds the Razorpay `receipt` used to find-or-create each leg's
 * order, so a fresh key would normally risk a second set of orders
 * (dev-logs/029's duplicate-order bug). It cannot here: every leg this
 * function acts on already has its `orderId` recorded in `pendingPaymentLegs`,
 * and `confirm_with_deposit` prefers that strongly-consistent local record
 * over asking Razorpay at all (`knownPendingLeg`). No lookup, no creation.
 *
 * The key is derived from the booking, so Razorpay's own webhook retries — and
 * the three separate deliveries a three-leg booking produces — all collapse
 * onto one claim rather than racing each other.
 */
export async function finalizeFromWebhook(bookingId: string, orderId: string, deps: AppDeps): Promise<{ finalized: boolean }> {
  const snapshot = await deps.eventStore.loadSnapshot(bookingId)

  // Only a booking still waiting on payment is our business. A CONFIRMED one
  // is already settled; an EXPIRED/CANCELLED one must not be resurrected by a
  // late webhook — that is reconciliation's job to report, not this
  // function's to paper over.
  if (!snapshot || snapshot.status !== 'HELD') {
    return { finalized: false }
  }

  const isOurLeg = snapshot.pendingPaymentLegs?.some((leg) => leg.orderId === orderId)
  if (!isOurLeg) {
    return { finalized: false }
  }

  // Reconstructed from the booking's own trail, since the webhook carries
  // neither. `agentId` is on the snapshot from `hold_slot`; the policy version
  // is not — the snapshot only gains it at confirm time, and this booking is
  // by definition not confirmed yet.
  //
  // So it comes from the booking's own `POLICY_ACKNOWLEDGED` event: the
  // version the customer actually agreed to, not whatever is active now. That
  // matters — if the merchant published a new policy while the customer was
  // paying, `confirm_with_deposit` must refuse with POLICY_VERSION_STALE
  // rather than quietly settle them under rules they never saw
  // (docs/03-domain-model.md §2). Taking the current active version here
  // would silently defeat that.
  const { agentId } = snapshot
  const history = await deps.eventStore.loadEvents(bookingId)
  const acknowledged = [...history].reverse().find((e) => e.type === 'POLICY_ACKNOWLEDGED')
  const policyVersion = acknowledged?.type === 'POLICY_ACKNOWLEDGED' ? acknowledged.policyVersion : undefined
  if (!agentId || policyVersion === undefined) {
    return { finalized: false }
  }

  try {
    const result = await confirmWithDeposit(
      {
        bookingId,
        agentId,
        acknowledgedPolicyVersion: policyVersion,
        idempotencyKey: `webhook_finalize_${bookingId}`,
      },
      deps,
    )
    return { finalized: result.status === 'CONFIRMED' }
  } catch (err) {
    // Never let this fail the webhook. Razorpay retries deliveries, the
    // agent's own retry path still exists, and reconciliation still reports a
    // genuinely stranded payment — this is an optimisation on top of three
    // existing safety nets, not a new single point of failure.
    deps.logger?.warn({ err, bookingId, orderId }, 'webhook-driven finalization failed; leaving the booking for the agent retry or reconciliation')
    return { finalized: false }
  }
}
