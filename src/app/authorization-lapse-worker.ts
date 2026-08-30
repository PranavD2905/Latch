import { createAuthorizationLapsedEvent, createSessionCompleteAuthorizationLapsedEvent } from '../domain/event-factory.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import type { AppDeps } from './types.js'

export interface AuthorizationLapseWorkerResult {
  lapsedBookingIds: readonly string[]
}

/**
 * docs/01-architecture.md §8 / dev-logs/005: a manual-capture authorisation
 * has at most a 5-day life (`manual_expiry_period` maxes at 7200 minutes).
 * This worker finds `CONFIRMED` bookings whose authorisation has passed its
 * `expiresAt` without that fact yet being recorded, and appends
 * `AUTHORIZATION_LAPSED` for each — one event, no status change
 * (docs/03-domain-model.md §3: the booking just sits `CONFIRMED` with an
 * uncollectable no-show fee). From that point `charge_no_show` refuses with
 * `AUTHORIZATION_EXPIRED` instead of discovering the loss only when someone
 * tries to collect, and a merchant reading the trail learns *why*.
 *
 * Idempotent and safe to run repeatedly / concurrently: the candidate list
 * comes from `EventStore.listConfirmedBookingsWithExpiredAuthorization`,
 * which already excludes bookings with `authorizationLapsedAt` set, and each
 * candidate is re-checked under its own row lock before the event is
 * appended — a booking resolved (charged, declined, or already lapsed by a
 * concurrent tick) between the list read and the lock is simply skipped.
 */
export async function runAuthorizationLapseWorker(deps: AppDeps): Promise<AuthorizationLapseWorkerResult> {
  const now = deps.clock.now()
  const candidates = await deps.eventStore.listConfirmedBookingsWithExpiredAuthorization(now)

  const lapsedBookingIds: string[] = []
  for (const candidate of candidates) {
    const didLapse = await deps.eventStore.transaction(async (tx) => {
      const fresh = await tx.loadSnapshotForUpdate(candidate.bookingId)
      if (!stillLapsable(fresh, now)) {
        return false
      }
      const snapshot = fresh as BookingSnapshot & { authorizationId: string; authorizationExpiresAt: Date }

      const sequence = snapshot.lastEventSequence + 1
      const event = createAuthorizationLapsedEvent(snapshot.bookingId, sequence, deps.clock, {
        authorizationId: snapshot.authorizationId,
        rail: deps.paymentRail.name,
      })
      const projection: BookingSnapshot = { ...snapshot, authorizationLapsedAt: now, lastEventSequence: sequence }
      await tx.append([event], projection, snapshot.merchantId)
      return true
    })
    if (didLapse) {
      lapsedBookingIds.push(candidate.bookingId)
    }
  }

  // Same sweep, for the session-complete mandate's own independent 5-day
  // manual-capture window — a structurally separate leg (see `schema.ts`'s
  // `sessionCompleteAuthorization*` columns), so it gets its own candidate
  // list and its own lapse event, not a flag on the loop above.
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

function stillLapsable(snapshot: BookingSnapshot | undefined, now: Date): boolean {
  if (!snapshot || snapshot.status !== 'CONFIRMED') return false
  if (!snapshot.authorizationId || !snapshot.authorizationExpiresAt) return false
  if (snapshot.authorizationLapsedAt) return false
  return snapshot.authorizationExpiresAt.getTime() <= now.getTime()
}

function stillSessionCompleteLapsable(snapshot: BookingSnapshot | undefined, now: Date): boolean {
  if (!snapshot || snapshot.status !== 'CONFIRMED') return false
  if (!snapshot.sessionCompleteAuthorizationId || !snapshot.sessionCompleteAuthorizationExpiresAt) return false
  if (snapshot.sessionCompleteAuthorizationLapsedAt) return false
  return snapshot.sessionCompleteAuthorizationExpiresAt.getTime() <= now.getTime()
}
