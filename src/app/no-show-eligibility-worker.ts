import { createNoShowEligibleEvent } from '../domain/event-factory.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import type { AppDeps } from './types.js'

export interface NoShowEligibilityWorkerResult {
  eligibleBookingIds: readonly string[]
}

/**
 * docs/01-architecture.md §8: "No-show window | Appointment start elapsed +
 * grace | Append NO_SHOW_ELIGIBLE — does not charge." Claims its batch with
 * `SELECT ... FOR UPDATE SKIP LOCKED`
 * (`EventStoreTx.claimConfirmedBookingsPastStart`), same discipline as
 * `hold-expiry-worker.ts`. That claim query is a *superset* of the truly
 * eligible set — it can only filter on `startsAt < now`, not `startsAt +
 * graceMinutes < now`, because grace minutes vary by the booking's own
 * recorded `policyVersion` (docs/03-domain-model.md §2), not the merchant's
 * current policy. Each claimed row is re-checked here, under the lock the
 * claim already holds, before deciding to append.
 *
 * **This does not charge anything and does not change `status`.**
 * docs/03-domain-model.md §3 Rule 3: time passing makes a charge
 * *permissible*, never makes one *happen*. It's also deliberately
 * independent of `charge_no_show`'s own gate (dev-logs/009): that gate
 * re-derives eligibility directly from the server clock rather than
 * depending on this event having landed first, and keeps requiring
 * `status === 'CONFIRMED'` — so this worker leaves `status` alone and only
 * sets `noShowEligibleMarkedAt` as an idempotency marker, the same
 * informational-only shape the Slice 4 authorisation-lapse worker uses for
 * `authorizationLapsedAt`. (A full event replay via `fold()` would compute
 * `status: 'NO_SHOW_ELIGIBLE'` for a booking past this point — that's the
 * *pure* domain model per docs/03-domain-model.md §3's state diagram; the
 * Postgres projection this worker and `charge_no_show`/`cancel`/`reschedule`
 * actually gate against deliberately does not track it, so those gates never
 * have to special-case a state `fold()` knows about but the live projection
 * doesn't. See dev-logs/010.)
 */
export async function runNoShowEligibilityWorker(deps: AppDeps): Promise<NoShowEligibilityWorkerResult> {
  const now = deps.clock.now()
  const eligibleBookingIds: string[] = []

  await deps.eventStore.transaction(async (tx) => {
    const claimed = await tx.claimConfirmedBookingsPastStart(now, 100)
    for (const snapshot of claimed) {
      if (snapshot.policyVersion === undefined) continue // defensive: a CONFIRMED booking always has one

      const policy = await deps.catalogRepo.getPolicyVersion(deps.merchantId, snapshot.policyVersion)
      if (!policy) continue // defensive: the version a CONFIRMED booking cites should never be gone

      const eligibleAt = new Date(snapshot.startsAt.getTime() + policy.noShowGraceMinutes * 60_000)
      if (now.getTime() < eligibleAt.getTime()) continue // start elapsed, still inside grace — reconsidered next tick

      const sequence = snapshot.lastEventSequence + 1
      const event = createNoShowEligibleEvent(snapshot.bookingId, sequence, deps.clock, {})
      const projection: BookingSnapshot = { ...snapshot, noShowEligibleMarkedAt: now, lastEventSequence: sequence }
      await tx.append([event], projection)
      eligibleBookingIds.push(snapshot.bookingId)
    }
  })

  return { eligibleBookingIds }
}
