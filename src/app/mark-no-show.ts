import { createNonAttendanceMarkedEvent } from '../domain/event-factory.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import type { AppDeps } from './types.js'

export interface MarkNoShowCommand {
  bookingId: string
  idempotencyKey: string
}

export interface MarkNoShowResult {
  bookingId: string
  nonAttendanceMarkedAt: string
}

export class BookingNotFoundError extends Error {}
/** The booking exists but isn't in a state non-attendance can be marked on — e.g. still HELD, or already terminal. */
export class BookingNotMarkableError extends Error {}

/**
 * `mark_no_show` — merchant-only, same trust boundary as `decline_booking`
 * (never registered as an MCP tool, only reachable via the merchant API's
 * bearer-token-gated route). This is the second of `charge_no_show`'s two
 * independent facts (docs/03-domain-model.md §3 Rule 3): recording that a
 * merchant, not an agent, affirmed the appointment went unattended. No gate
 * beyond "the booking is CONFIRMED" — the elapsed-time fact is entirely
 * `charge_no_show`'s own concern, re-derived from the server clock there
 * rather than duplicated here, so there is exactly one place that logic
 * can drift.
 */
export async function markNoShow(cmd: MarkNoShowCommand, deps: AppDeps): Promise<MarkNoShowResult> {
  const cached = await deps.idempotencyStore.get<MarkNoShowResult>('mark_no_show', cmd.idempotencyKey)
  if (cached) {
    return cached
  }

  const result = await deps.eventStore.transaction<MarkNoShowResult>(async (tx) => {
    const snapshot = await tx.loadSnapshotForUpdate(cmd.bookingId)
    if (!snapshot) {
      throw new BookingNotFoundError(`unknown booking: ${cmd.bookingId}`)
    }
    if (snapshot.status !== 'CONFIRMED') {
      throw new BookingNotMarkableError(`booking ${cmd.bookingId} is not CONFIRMED — only a confirmed booking can be marked as a no-show`)
    }

    // Already marked — a domain-level no-op independent of idempotencyKey,
    // so a merchant re-marking (a different key, e.g. a UI retry) doesn't
    // append a second NON_ATTENDANCE_MARKED event.
    if (snapshot.nonAttendanceMarkedAt) {
      return { bookingId: cmd.bookingId, nonAttendanceMarkedAt: snapshot.nonAttendanceMarkedAt.toISOString() }
    }

    const now = deps.clock.now()
    const sequence = snapshot.lastEventSequence + 1
    const event = createNonAttendanceMarkedEvent(cmd.bookingId, sequence, deps.clock, { markedBy: 'merchant' })
    const projection: BookingSnapshot = { ...snapshot, nonAttendanceMarkedAt: now, lastEventSequence: sequence }
    await tx.append([event], projection)

    return { bookingId: cmd.bookingId, nonAttendanceMarkedAt: now.toISOString() }
  })

  await deps.idempotencyStore.put('mark_no_show', cmd.idempotencyKey, result)
  return result
}
