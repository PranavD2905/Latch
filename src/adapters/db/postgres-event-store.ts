import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { BookingEvent } from '../../domain/events.js'
import type { BookingStatus } from '../../domain/fold.js'
import { toPaise } from '../../domain/money.js'
import type { BookingSnapshot, BusyInterval, EventStore, EventStoreTx, EventWithGlobalSequence } from '../../ports/event-store.js'
import type { Db } from './client.js'
import { bookings, events, services } from './schema.js'

const LIVE_STATUSES = ['held', 'confirmed'] as const

/** BookingStatus ('HELD') <-> the db enum's values ('held'). Same set, one is upper snake, one lower. */
function toDbStatus(status: BookingStatus): (typeof bookings.status.enumValues)[number] {
  return status.toLowerCase() as (typeof bookings.status.enumValues)[number]
}
function fromDbStatus(status: string): BookingStatus {
  return status.toUpperCase() as BookingStatus
}

// jsonb round-trips Date fields as ISO strings; this reviver walks the
// deserialised payload and turns any ISO-8601 string back into a Date, so
// callers get back exactly the BookingEvent shape they appended.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function hydrateDates(value: unknown): unknown {
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
    return new Date(value)
  }
  if (Array.isArray(value)) {
    return value.map(hydrateDates)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      out[key] = hydrateDates(v)
    }
    return out
  }
  return value
}

function rowToSnapshot(row: typeof bookings.$inferSelect): BookingSnapshot {
  return {
    bookingId: row.bookingId,
    merchantId: row.merchantId,
    practitionerId: row.practitionerId,
    serviceId: row.serviceId,
    startsAt: row.startsAt,
    status: fromDbStatus(row.status),
    policyVersion: row.policyVersion ?? undefined,
    authorizationId: row.authorizationId ?? undefined,
    authorizationAmountPaise: row.authorizationAmountPaise !== null ? toPaise(row.authorizationAmountPaise) : undefined,
    authorizationExpiresAt: row.authorizationExpiresAt ?? undefined,
    authorizationLapsedAt: row.authorizationLapsedAt ?? undefined,
    nonAttendanceMarkedAt: row.nonAttendanceMarkedAt ?? undefined,
    noShowEligibleMarkedAt: row.noShowEligibleMarkedAt ?? undefined,
    agentId: row.agentId ?? undefined,
    holdExpiresAt: row.holdExpiresAt ?? undefined,
    lastEventSequence: row.lastEventSequence,
  }
}

// Any-typed database handle: this file is written once against either the
// top-level `Db` or a `db.transaction()` callback's `tx`, whose types differ
// only in ways irrelevant to the queries used here (both support
// select/insert/update with the same table refs).
type Queryable = Db

async function loadEventsFor(db: Queryable, bookingId: string): Promise<readonly BookingEvent[]> {
  const rows = await db.select().from(events).where(eq(events.bookingId, bookingId)).orderBy(events.sequence)
  return rows.map((row) => hydrateDates(row.payload) as BookingEvent)
}

async function appendFor(db: Queryable, evts: readonly BookingEvent[], projection: BookingSnapshot | undefined, merchantId: string): Promise<void> {
  if (evts.length === 0) {
    throw new Error('append() called with no events')
  }

  await db.insert(events).values(
    evts.map((event) => ({
      eventId: event.eventId,
      bookingId: event.bookingId,
      type: event.type,
      occurredAt: event.occurredAt,
      sequence: event.sequence,
      payload: event as unknown as Record<string, unknown>,
      merchantId,
    })),
  )

  if (!projection) {
    return // a pure refusal that never became a live booking — event recorded, no projection row.
  }

  const now = new Date()
  await db
    .insert(bookings)
    .values({
      bookingId: projection.bookingId,
      merchantId: projection.merchantId,
      practitionerId: projection.practitionerId,
      serviceId: projection.serviceId,
      startsAt: projection.startsAt,
      status: toDbStatus(projection.status),
      policyVersion: projection.policyVersion ?? null,
      authorizationId: projection.authorizationId ?? null,
      authorizationAmountPaise: projection.authorizationAmountPaise ?? null,
      authorizationExpiresAt: projection.authorizationExpiresAt ?? null,
      authorizationLapsedAt: projection.authorizationLapsedAt ?? null,
      nonAttendanceMarkedAt: projection.nonAttendanceMarkedAt ?? null,
      noShowEligibleMarkedAt: projection.noShowEligibleMarkedAt ?? null,
      agentId: projection.agentId ?? null,
      holdExpiresAt: projection.holdExpiresAt ?? null,
      lastEventSequence: projection.lastEventSequence,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: bookings.bookingId,
      set: {
        // startsAt: Slice 5 fix — `reschedule` moves a booking's slot on the
        // *same* row (update, not a new booking), and this field was missing
        // from the update set entirely: every prior slice only ever wrote
        // startsAt once, at insert, so nothing had exercised the gap before.
        startsAt: projection.startsAt,
        status: toDbStatus(projection.status),
        policyVersion: projection.policyVersion ?? null,
        authorizationId: projection.authorizationId ?? null,
        authorizationAmountPaise: projection.authorizationAmountPaise ?? null,
        authorizationExpiresAt: projection.authorizationExpiresAt ?? null,
        authorizationLapsedAt: projection.authorizationLapsedAt ?? null,
        nonAttendanceMarkedAt: projection.nonAttendanceMarkedAt ?? null,
        noShowEligibleMarkedAt: projection.noShowEligibleMarkedAt ?? null,
        agentId: projection.agentId ?? null,
        holdExpiresAt: projection.holdExpiresAt ?? null,
        lastEventSequence: projection.lastEventSequence,
        updatedAt: now,
      },
    })
}

/** Postgres implementation of `EventStore`. docs/03-domain-model.md §7. */
export class PostgresEventStore implements EventStore {
  constructor(private readonly db: Db) {}

  async transaction<T>(fn: (tx: EventStoreTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (trx) => {
      const trxDb = trx as unknown as Db
      const tx: EventStoreTx = {
        loadEvents: (bookingId) => loadEventsFor(trxDb, bookingId),
        loadSnapshotForUpdate: async (bookingId) => {
          const rows = await trxDb.select().from(bookings).where(eq(bookings.bookingId, bookingId)).for('update').limit(1)
          const row = rows[0]
          return row ? rowToSnapshot(row) : undefined
        },
        append: (evts, projection, merchantId) => appendFor(trxDb, evts, projection, merchantId),
        countLiveHoldsForAgent: (merchantId, agentId) => countLiveHoldsFor(trxDb, merchantId, agentId),
        claimHeldBookingsWithExpiredHold: (now, limit) => claimHeldBookingsWithExpiredHoldFor(trxDb, now, limit),
        claimConfirmedBookingsPastStart: (now, limit) => claimConfirmedBookingsPastStartFor(trxDb, now, limit),
        countBookingsCreatedByAgentSince: (merchantId, agentId, since) => countBookingsCreatedByAgentSinceFor(trxDb, merchantId, agentId, since),
        lockAgent: async (merchantId, agentId) => {
          // pg_advisory_xact_lock: held until this transaction commits or
          // rolls back, and serializes against any other transaction taking
          // the same key — including another connection's hold_slot call
          // for this same (merchantId, agentId) pair. Keying on the pair,
          // not `agentId` alone (migration 0011), so an agent transacting
          // with two unrelated merchants — or two different agents that
          // happen to reuse the same id string at different merchants —
          // never serialize against or rate-limit against each other.
          // hashtext() folds the composite string key to the bigint
          // pg_advisory_xact_lock needs.
          await trxDb.execute(sql`select pg_advisory_xact_lock(hashtext(${`${merchantId}:${agentId}`}))`)
        },
      }
      return fn(tx)
    })
  }

  async loadSnapshot(bookingId: string): Promise<BookingSnapshot | undefined> {
    const rows = await this.db.select().from(bookings).where(eq(bookings.bookingId, bookingId)).limit(1)
    const row = rows[0]
    return row ? rowToSnapshot(row) : undefined
  }

  async loadEvents(bookingId: string): Promise<readonly BookingEvent[]> {
    return loadEventsFor(this.db, bookingId)
  }

  async listOpenBookingsForReconciliation(limit: number): Promise<readonly BookingSnapshot[]> {
    const rows = await this.db.select().from(bookings).where(eq(bookings.status, 'confirmed')).orderBy(bookings.updatedAt).limit(limit)
    return rows.map(rowToSnapshot)
  }

  async listLiveIntervals(practitionerId: string, from: Date, to: Date): Promise<readonly BusyInterval[]> {
    // Widened lower bound: a live booking that started up to 24h before `from`
    // could still extend into [from, to) for a long service. `computeSlots`
    // does its own precise overlap check, so over-fetching here is harmless.
    const widenedFrom = new Date(from.getTime() - 24 * 60 * 60 * 1000)
    const rows = await this.db
      .select({ startsAt: bookings.startsAt, durationMinutes: services.durationMinutes })
      .from(bookings)
      .innerJoin(services, eq(services.serviceId, bookings.serviceId))
      .where(
        and(
          eq(bookings.practitionerId, practitionerId),
          inArray(bookings.status, [...LIVE_STATUSES]),
          lt(bookings.startsAt, to),
          gte(bookings.startsAt, widenedFrom),
        ),
      )
    return rows.map((row) => ({
      startsAt: row.startsAt,
      endsAt: new Date(row.startsAt.getTime() + row.durationMinutes * 60_000),
    }))
  }

  async countLiveHoldsForAgent(merchantId: string, agentId: string): Promise<number> {
    return countLiveHoldsFor(this.db, merchantId, agentId)
  }

  async listConfirmedBookingsWithExpiredAuthorization(now: Date): Promise<readonly BookingSnapshot[]> {
    const rows = await this.db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.status, 'confirmed'),
          isNotNull(bookings.authorizationExpiresAt),
          lt(bookings.authorizationExpiresAt, now),
          isNull(bookings.authorizationLapsedAt),
        ),
      )
    return rows.map(rowToSnapshot)
  }

  async listAllEvents(merchantId: string, afterGlobalSequence?: number): Promise<readonly EventWithGlobalSequence[]> {
    const rows =
      afterGlobalSequence === undefined
        ? await this.db
            .select()
            .from(events)
            .where(eq(events.merchantId, merchantId))
            .orderBy(events.globalSequence)
        : await this.db
            .select()
            .from(events)
            .where(and(eq(events.merchantId, merchantId), gt(events.globalSequence, afterGlobalSequence)))
            .orderBy(events.globalSequence)
    return rows.map((row) => ({ event: hydrateDates(row.payload) as BookingEvent, globalSequence: row.globalSequence }))
  }

  async findGlobalSequence(merchantId: string, eventId: string): Promise<number | undefined> {
    const rows = await this.db
      .select({ globalSequence: events.globalSequence })
      .from(events)
      .where(and(eq(events.eventId, eventId), eq(events.merchantId, merchantId)))
      .limit(1)
    return rows[0]?.globalSequence
  }
}

/**
 * The background worker's claim query — docs/02-tech-stack.md §9 / §9 of
 * 01-architecture.md: "claim rows with FOR UPDATE SKIP LOCKED." A row
 * currently locked by a concurrent `confirm_with_deposit` gate transaction
 * (Race 2, docs/03-domain-model.md §7) is simply absent from the result this
 * tick, not blocked on — the worker picks it up next tick once it's free.
 */
async function claimHeldBookingsWithExpiredHoldFor(db: Queryable, now: Date, limit: number): Promise<readonly BookingSnapshot[]> {
  const rows = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.status, 'held'), isNotNull(bookings.holdExpiresAt), lt(bookings.holdExpiresAt, now)))
    .limit(limit)
    .for('update', { skipLocked: true })
  return rows.map(rowToSnapshot)
}

/**
 * A superset of the truly no-show-eligible set — grace minutes vary by the
 * booking's own recorded `policyVersion`, so the caller re-checks
 * `startsAt + graceMinutes` per candidate under this same row lock before
 * deciding to append `NO_SHOW_ELIGIBLE`. See `EventStoreTx.claimConfirmedBookingsPastStart`.
 */
async function claimConfirmedBookingsPastStartFor(db: Queryable, now: Date, limit: number): Promise<readonly BookingSnapshot[]> {
  const rows = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.status, 'confirmed'), lt(bookings.startsAt, now), isNull(bookings.noShowEligibleMarkedAt)))
    .limit(limit)
    .for('update', { skipLocked: true })
  return rows.map(rowToSnapshot)
}

async function countLiveHoldsFor(db: Queryable, merchantId: string, agentId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.merchantId, merchantId), eq(bookings.agentId, agentId), eq(bookings.status, 'held')))
  return rows[0]?.count ?? 0
}

/**
 * dev-logs/014, gap 2's request-rate ceiling. Counts every `HOLD_CREATED`
 * event attributed to this agent since `since`, regardless of what that
 * booking's *current* status is — a hold that has since expired or been
 * released still counts against the rate, since the point is bounding
 * *request volume*, not currently-live holds (that's `countLiveHoldsFor`, a
 * different bound). Deliberately joins on `events.occurredAt`, not
 * `bookings.createdAt`/`updatedAt`: those two projection columns are set
 * from real wall-clock time (`new Date()` in `appendFor`, below) rather than
 * `Clock.now()` — the one exception to docs/01-architecture.md §5's "the
 * server clock is the only clock," because they're DB bookkeeping metadata,
 * not a domain-meaningful timestamp. `since` here is derived from
 * `deps.clock.now()` in `hold-slot.ts`, so comparing it against wall-clock
 * `createdAt` would silently compare two different timelines — invisible in
 * production (where `Clock` *is* the wall clock) but wrong against a
 * `FrozenClock` in tests, which is how this was actually caught.
 */
async function countBookingsCreatedByAgentSinceFor(db: Queryable, merchantId: string, agentId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(events)
    .innerJoin(bookings, eq(bookings.bookingId, events.bookingId))
    .where(and(eq(bookings.merchantId, merchantId), eq(bookings.agentId, agentId), eq(events.type, 'HOLD_CREATED'), gte(events.occurredAt, since)))
  return rows[0]?.count ?? 0
}

