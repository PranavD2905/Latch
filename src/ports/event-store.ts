import type { BookingEvent } from '../domain/events.js'
import type { BookingStatus } from '../domain/fold.js'
import type { Paise } from '../domain/money.js'

/**
 * The `bookings` projection row, as read/written by the store. Mirrors
 * `src/adapters/db/schema.ts`'s `bookings` table plus the two columns this
 * slice adds (`agentId`, `holdExpiresAt`) — see the Slice 1 migration.
 */
export interface BookingSnapshot {
  bookingId: string
  practitionerId: string
  serviceId: string
  startsAt: Date
  status: BookingStatus
  policyVersion: number | undefined
  /** The no-show authorisation currently held against this booking — undefined before AUTHORIZATION_HELD, or after it's been captured/released. */
  authorizationId: string | undefined
  /**
   * The amount actually authorised — cited by `charge_no_show` as the
   * capture request, never re-derived from the merchant's *current* policy
   * (docs/03-domain-model.md §2: money rules don't change retroactively on
   * a booking already confirmed). If the merchant has since raised the
   * no-show fee, capturing at the new, higher figure would itself trigger
   * dev-logs/005 constraint 1 — the rail refuses any capture that isn't
   * exactly what was authorised.
   */
  authorizationAmountPaise: Paise | undefined
  /** Set alongside `authorizationId` — when this rail's authorisation window lapses (`manual_capture`'s `manual_expiry_period`). */
  authorizationExpiresAt: Date | undefined
  /** Set once the authorisation-lapse worker (or a gate check) has observed `authorizationExpiresAt` has passed. Prevents the worker re-emitting `AUTHORIZATION_LAPSED`. */
  authorizationLapsedAt: Date | undefined
  /** Set by the merchant API's mark-no-show route — the second of `charge_no_show`'s two independent facts (docs/03-domain-model.md §3 Rule 3). */
  nonAttendanceMarkedAt: Date | undefined
  /** Set once the no-show-eligibility worker has recorded `NO_SHOW_ELIGIBLE` — an idempotency marker only, never gates `charge_no_show`. */
  noShowEligibleMarkedAt: Date | undefined
  agentId: string | undefined
  /** Set only while status is HELD — when the hold's TTL expires. */
  holdExpiresAt: Date | undefined
  lastEventSequence: number
}

export interface BusyInterval {
  startsAt: Date
  endsAt: Date
}

/**
 * Everything a command handler can do to a single booking's history and
 * projection row *inside one database transaction*. docs/03-domain-model.md
 * §7: "when correctness depends on a check and an action being one thing,
 * they must be inside a database transaction, not adjacent lines of
 * TypeScript." `loadSnapshotForUpdate` takes the row lock; `append` is the
 * only way to write, and it always writes the event(s) and the projection
 * together — there is no method that updates the projection without a
 * causing event, by construction (docs/03-domain-model.md §1).
 */
export interface EventStoreTx {
  loadEvents(bookingId: string): Promise<readonly BookingEvent[]>
  /** `SELECT ... FOR UPDATE` on the booking row — undefined if it doesn't exist yet. */
  loadSnapshotForUpdate(bookingId: string): Promise<BookingSnapshot | undefined>
  /**
   * Appends one or more events for a single booking and writes the resulting
   * projection row, atomically. `projection` is `undefined` for a pure
   * refusal that never became a live booking (e.g. `SLOT_TAKEN` on a fresh
   * `hold_slot` attempt) — the event is still recorded, just with no
   * corresponding `bookings` row.
   */
  append(events: readonly BookingEvent[], projection: BookingSnapshot | undefined): Promise<void>
  /** How many bookings this agent currently has HELD — read inside the transaction, after `lockAgent`. */
  countLiveHoldsForAgent(agentId: string): Promise<number>
  /**
   * A Postgres advisory lock (`pg_advisory_xact_lock`), scoped to `key` and
   * held for the lifetime of this transaction — released automatically on
   * commit or rollback. docs/01-architecture.md §1 Idea 3 claims the
   * concurrent-holds-per-agent bound is enforced by "Latch + DB constraint,"
   * not just app logic (the "No — DB constraint" column). A plain
   * count-then-insert has a race: two concurrent `hold_slot` calls from the
   * same agent can both read a count under the limit before either inserts.
   * Calling `lockAgent(agentId)` first serializes every `hold_slot` attempt
   * from the same agent through this transaction, closing that race —
   * exactly the DB-level guarantee the docs claim. See dev-logs/004.
   */
  lockAgent(agentId: string): Promise<void>
  /**
   * `SELECT ... FOR UPDATE SKIP LOCKED` — held bookings whose `holdExpiresAt`
   * has passed. docs/01-architecture.md §9 / prompts/slice-5.md item 3: the
   * background worker claims a batch this way rather than a plain unlocked
   * read followed by a per-row re-check, so a row a concurrent
   * `confirm_with_deposit` is already holding is simply skipped this tick,
   * not blocked on. The WHERE clause plus the row lock together *are* the
   * "still expirable" check — Race 2 (docs/03-domain-model.md §7): whichever
   * transaction locks the row first wins, the other observes the committed
   * result.
   */
  claimHeldBookingsWithExpiredHold(now: Date, limit: number): Promise<readonly BookingSnapshot[]>
  /**
   * `SELECT ... FOR UPDATE SKIP LOCKED` — confirmed bookings whose
   * appointment `startsAt` has passed and `noShowEligibleMarkedAt` is not yet
   * set. A superset of the truly-eligible set (grace period still varies by
   * the booking's own recorded `policyVersion` — docs/03-domain-model.md §2 —
   * so the caller must still compute `startsAt + graceMinutes` per candidate
   * before deciding to append `NO_SHOW_ELIGIBLE`); the row lock is what makes
   * that per-candidate check-then-append atomic against a concurrent
   * `reschedule`/`cancel` on the same booking.
   */
  claimConfirmedBookingsPastStart(now: Date, limit: number): Promise<readonly BookingSnapshot[]>
}

/**
 * Outbound port over the event log + booking projection. docs/01-architecture.md
 * system diagram calls this `EventStore`; it also owns projection reads
 * that don't need a transaction (slot search, hold-count gate) since those
 * are the same underlying table.
 */
export interface EventStore {
  /** Runs `fn` inside one DB transaction; the same as docs §7's `SELECT ... FOR UPDATE` unit of work. */
  transaction<T>(fn: (tx: EventStoreTx) => Promise<T>): Promise<T>

  /** Read-only, unlocked. For display / non-gating reads. */
  loadSnapshot(bookingId: string): Promise<BookingSnapshot | undefined>

  /** Live (held/confirmed) booking intervals for a practitioner in `[from, to)` — slot computation input. */
  listLiveIntervals(practitionerId: string, from: Date, to: Date): Promise<readonly BusyInterval[]>

  /** How many bookings this agent currently has HELD — the concurrent-hold gate. */
  countLiveHoldsForAgent(agentId: string): Promise<number>

  /**
   * CONFIRMED bookings whose no-show authorisation has passed `expiresAt`
   * but have not yet had that fact recorded (`authorizationLapsedAt` unset).
   * The authorisation-lapse worker's input — docs/01-architecture.md §8.
   */
  listConfirmedBookingsWithExpiredAuthorization(now: Date): Promise<readonly BookingSnapshot[]>
}
