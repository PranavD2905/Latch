import type { BookingEvent } from '../../domain/events.js'
import type { BookingSnapshot, BusyInterval, EventStore, EventStoreTx, EventWithGlobalSequence } from '../../ports/event-store.js'

const DEFAULT_SERVICE_DURATION_MINUTES = 30

/**
 * `EventStore`'s in-memory test double — same role as `FakePaymentProvider`/
 * `FakePaymentRail` (docs/02-tech-stack.md §13), but for a port that had no
 * fake at all before this: every command handler is written against this
 * interface, yet the only implementation was `PostgresEventStore`, so any
 * test of gate/refusal logic, event-shape assertions, or idempotency
 * interaction needed a live Postgres — 21 of this project's 32 test files
 * were `.integration.test.ts` for exactly this reason, not because the
 * logic itself needed a real database.
 *
 * This does **not** replace those integration tests. It cannot: there is no
 * real row lock, no real `FOR UPDATE SKIP LOCKED`, no real partial unique
 * index, and `transaction()` here is a plain function call with no
 * isolation from a concurrent caller in the same process — `lockAgent` is a
 * documented no-op. Race 1 (`one_live_booking_per_slot`), Race 2
 * (hold-expiry vs. confirm), and the advisory-lock-guarded background-worker
 * concurrency tests all genuinely need Postgres and stay
 * `.integration.test.ts`. What this *is* for: the much larger set of
 * ordinary command-handler paths — a gate passes, a gate refuses, an event
 * gets appended with the right shape, an idempotency replay short-circuits —
 * that were paying the cost of a live database connection for logic that
 * never actually depended on one. See `confirm-with-deposit.fast.test.ts`
 * for the intended usage pattern.
 */
export class FakeEventStore implements EventStore {
  private readonly bookings = new Map<string, BookingSnapshot>()
  private readonly eventsByBooking = new Map<string, BookingEvent[]>()
  private readonly allEvents: { event: BookingEvent; globalSequence: number; merchantId: string }[] = []
  private readonly serviceDurationMinutes = new Map<string, number>()
  private nextGlobalSequence = 1

  /** Test setup only — `listLiveIntervals` needs a service's duration and this fake has no `CatalogRepo` of its own to ask. Unset services default to 30 minutes. */
  setServiceDurationMinutes(serviceId: string, minutes: number): void {
    this.serviceDurationMinutes.set(serviceId, minutes)
  }

  async transaction<T>(fn: (tx: EventStoreTx) => Promise<T>): Promise<T> {
    return fn(this.tx())
  }

  private tx(): EventStoreTx {
    return {
      loadEvents: (bookingId) => this.loadEvents(bookingId),
      loadSnapshotForUpdate: (bookingId) => this.loadSnapshot(bookingId),
      append: (events, projection, merchantId) => this.append(events, projection, merchantId),
      countLiveHoldsForAgent: (merchantId, agentId) => this.countLiveHoldsForAgent(merchantId, agentId),
      // No-op, deliberately — see the class doc comment. A test that needs
      // to prove the *lock itself* works belongs against `PostgresEventStore`.
      lockAgent: async () => {},
      claimHeldBookingsWithExpiredHold: (now, limit) => this.claimHeldBookingsWithExpiredHold(now, limit),
      countBookingsCreatedByAgentSince: (merchantId, agentId, since) => this.countBookingsCreatedByAgentSince(merchantId, agentId, since),
    }
  }

  private async append(events: readonly BookingEvent[], projection: BookingSnapshot | undefined, merchantId: string): Promise<void> {
    if (events.length === 0) {
      throw new Error('append() called with no events')
    }
    const bookingId = events[0]!.bookingId
    const existing = this.eventsByBooking.get(bookingId) ?? []
    this.eventsByBooking.set(bookingId, [...existing, ...events])
    for (const event of events) {
      this.allEvents.push({ event, globalSequence: this.nextGlobalSequence++, merchantId })
    }
    if (projection) {
      this.bookings.set(bookingId, projection)
    }
  }

  async loadSnapshot(bookingId: string): Promise<BookingSnapshot | undefined> {
    return this.bookings.get(bookingId)
  }

  async loadEvents(bookingId: string): Promise<readonly BookingEvent[]> {
    return this.eventsByBooking.get(bookingId) ?? []
  }

  async listOpenBookingsForReconciliation(limit: number): Promise<readonly BookingSnapshot[]> {
    return [...this.bookings.values()].filter((b) => b.status === 'CONFIRMED').slice(0, limit)
  }

  async listLiveIntervals(practitionerId: string, from: Date, to: Date): Promise<readonly BusyInterval[]> {
    const widenedFrom = new Date(from.getTime() - 24 * 60 * 60 * 1000)
    return [...this.bookings.values()]
      .filter((b) => b.practitionerId === practitionerId && (b.status === 'HELD' || b.status === 'CONFIRMED') && b.startsAt < to && b.startsAt >= widenedFrom)
      .map((b) => {
        const durationMinutes = this.serviceDurationMinutes.get(b.serviceId) ?? DEFAULT_SERVICE_DURATION_MINUTES
        return { startsAt: b.startsAt, endsAt: new Date(b.startsAt.getTime() + durationMinutes * 60_000) }
      })
  }

  async countLiveHoldsForAgent(merchantId: string, agentId: string): Promise<number> {
    return [...this.bookings.values()].filter((b) => b.merchantId === merchantId && b.agentId === agentId && b.status === 'HELD').length
  }

  async listConfirmedBookingsWithExpiredSessionCompleteAuthorization(now: Date): Promise<readonly BookingSnapshot[]> {
    return [...this.bookings.values()].filter(
      (b) =>
        b.status === 'CONFIRMED' &&
        b.sessionCompleteAuthorizationExpiresAt !== undefined &&
        b.sessionCompleteAuthorizationExpiresAt < now &&
        b.sessionCompleteAuthorizationLapsedAt === undefined,
    )
  }

  async listAllEvents(merchantId: string, afterGlobalSequence?: number): Promise<readonly EventWithGlobalSequence[]> {
    return this.allEvents
      .filter((e) => e.merchantId === merchantId && (afterGlobalSequence === undefined || e.globalSequence > afterGlobalSequence))
      .sort((a, b) => a.globalSequence - b.globalSequence)
      .map((e) => ({ event: e.event, globalSequence: e.globalSequence }))
  }

  async findGlobalSequence(merchantId: string, eventId: string): Promise<number | undefined> {
    return this.allEvents.find((e) => e.merchantId === merchantId && e.event.eventId === eventId)?.globalSequence
  }

  private async claimHeldBookingsWithExpiredHold(now: Date, limit: number): Promise<readonly BookingSnapshot[]> {
    return [...this.bookings.values()].filter((b) => b.status === 'HELD' && b.holdExpiresAt !== undefined && b.holdExpiresAt < now).slice(0, limit)
  }

  private async countBookingsCreatedByAgentSince(merchantId: string, agentId: string, since: Date): Promise<number> {
    let count = 0
    for (const [bookingId, booking] of this.bookings) {
      if (booking.merchantId !== merchantId || booking.agentId !== agentId) continue
      const hasRecentHold = (this.eventsByBooking.get(bookingId) ?? []).some((e) => e.type === 'HOLD_CREATED' && e.occurredAt >= since)
      if (hasRecentHold) count++
    }
    return count
  }
}
