import { createSessionCompleteAuthorizationLapsedEvent } from '../domain/event-factory.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import type { AppDeps } from './types.js'

export interface AuthorizationLapseWorkerResult {
  lapsedBookingIds: readonly string[]
}

/**
 * docs/01-architecture.md §8 / dev-logs/005: a manual-capture authorisation
 * has at most a 5-day life (`manual_expiry_period` maxes at 7200 minutes).
 * This worker finds `CONFIRMED` bookings whose session-complete mandate has
 * passed its `expiresAt` without that fact yet being recorded, and appends
 * `SESSION_COMPLETE_AUTHORIZATION_LAPSED` for each — one event, no status
 * change. From that point `mark_complete` would find nothing left to
 * capture for this leg instead of discovering the loss only when someone
 * tries to collect, and a merchant reading the trail learns *why*.
 *
 * Idempotent and safe to run repeatedly / concurrently: the candidate list
 * comes from `EventStore.listConfirmedBookingsWithExpiredSessionCompleteAuthorization`,
 * which already excludes bookings with `sessionCompleteAuthorizationLapsedAt`
 * set, and each candidate is re-checked under its own row lock before the
 * event is appended — a booking resolved (completed, cancelled, declined, or
 * already lapsed by a concurrent tick) between the list read and the lock is
 * simply skipped.
 *
 * (Used to sweep a second, no-show-leg candidate list too — removed along
 * with the no-show feature; see the dev log for that removal. Any
 * `AUTHORIZATION_LAPSED` event already in a pre-removal booking's history
 * stays there untouched, this worker just never appends another.)
 */
export async function runAuthorizationLapseWorker(deps: AppDeps): Promise<AuthorizationLapseWorkerResult> {
  const now = deps.clock.now()
  const lapsedBookingIds: string[] = []

  const sessionCompleteCandidates = await deps.eventStore.listConfirmedBookingsWithExpiredSessionCompleteAuthorization(now)
  for (const candidate of sessionCompleteCandidates) {
    const didLapse = await deps.eventStore.transaction(async (tx) => {
      const fresh = await tx.loadSnapshotForUpdate(candidate.bookingId)
      if (!stillSessionCompleteLapsable(fresh, now)) {
        return false
      }
      const snapshot = fresh as BookingSnapshot & { sessionCompleteAuthorizationId: string; sessionCompleteAuthorizationExpiresAt: Date }

      const sequence = snapshot.lastEventSequence + 1
      const event = createSessionCompleteAuthorizationLapsedEvent(snapshot.bookingId, sequence, deps.clock, {
        authorizationId: snapshot.sessionCompleteAuthorizationId,
        rail: deps.paymentRail.name,
      })
      const projection: BookingSnapshot = { ...snapshot, sessionCompleteAuthorizationLapsedAt: now, lastEventSequence: sequence }
      await tx.append([event], projection, snapshot.merchantId)
      return true
    })
    if (didLapse && !lapsedBookingIds.includes(candidate.bookingId)) {
      lapsedBookingIds.push(candidate.bookingId)
    }
  }

  return { lapsedBookingIds }
}

function stillSessionCompleteLapsable(snapshot: BookingSnapshot | undefined, now: Date): boolean {
  if (!snapshot || snapshot.status !== 'CONFIRMED') return false
  if (!snapshot.sessionCompleteAuthorizationId || !snapshot.sessionCompleteAuthorizationExpiresAt) return false
  if (snapshot.sessionCompleteAuthorizationLapsedAt) return false
  return snapshot.sessionCompleteAuthorizationExpiresAt.getTime() <= now.getTime()
}
