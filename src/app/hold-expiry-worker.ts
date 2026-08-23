import { createHoldExpiredEvent } from '../domain/event-factory.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import type { AppDeps } from './types.js'

export interface HoldExpiryWorkerResult {
  expiredBookingIds: readonly string[]
}

/**
 * docs/01-architecture.md §8/§9: "Hold expiry | TTL elapsed | Append
 * HOLD_EXPIRED, release slot." Claims its batch with `SELECT ... FOR UPDATE
 * SKIP LOCKED` (`EventStoreTx.claimHeldBookingsWithExpiredHold`) — the WHERE
 * clause (`status='held' AND holdExpiresAt < now`) plus the row lock
 * together *are* the "still expirable" check, done once, atomically, rather
 * than an unlocked list read followed by a per-row re-check under its own
 * lock (contrast the Slice 4 authorisation-lapse worker, which predates this
 * pattern).
 *
 * This is Race 2 (docs/03-domain-model.md §7): `confirm_with_deposit`'s own
 * gate transaction takes `SELECT ... FOR UPDATE` (no skip) on the same
 * booking row and re-reads `holdExpiresAt` inside that lock. Whichever
 * transaction — this worker's claim, or a live `confirm_with_deposit` —
 * acquires the row lock first wins; SKIP LOCKED means this worker never
 * blocks waiting for a booking a customer is actively confirming, it just
 * leaves that row for `confirm_with_deposit` to finish with and picks it up
 * next tick if it's still HELD and still expired then.
 */
export async function runHoldExpiryWorker(deps: AppDeps): Promise<HoldExpiryWorkerResult> {
  const now = deps.clock.now()
  const expiredBookingIds: string[] = []

  await deps.eventStore.transaction(async (tx) => {
    const claimed = await tx.claimHeldBookingsWithExpiredHold(now, 100)
    for (const snapshot of claimed) {
      const sequence = snapshot.lastEventSequence + 1
      const event = createHoldExpiredEvent(snapshot.bookingId, sequence, deps.clock, {})
      // The partial unique index (`status IN ('held','confirmed')`) is what
      // actually frees the slot — flipping status to EXPIRED here is that
      // release, not a second mechanism alongside it.
      const projection: BookingSnapshot = { ...snapshot, status: 'EXPIRED', lastEventSequence: sequence }
      await tx.append([event], projection)
      expiredBookingIds.push(snapshot.bookingId)
    }
  })

  return { expiredBookingIds }
}
