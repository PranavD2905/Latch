import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { BookingEvent } from '../../domain/events.js'
import type { BookingStatus } from '../../domain/fold.js'
import { toPaise } from '../../domain/money.js'
import type { BookingSnapshot, BusyInterval, EventStore, EventStoreTx } from '../../ports/event-store.js'
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

async function appendFor(db: Queryable, evts: readonly BookingEvent[], projection: BookingSnapshot | undefined): Promise<void> {
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
      agentId: projection.agentId ?? null,
      holdExpiresAt: projection.holdExpiresAt ?? null,
      lastEventSequence: projection.lastEventSequence,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: bookings.bookingId,
      set: {
        status: toDbStatus(projection.status),
        policyVersion: projection.policyVersion ?? null,
        authorizationId: projection.authorizationId ?? null,
        authorizationAmountPaise: projection.authorizationAmountPaise ?? null,
        authorizationExpiresAt: projection.authorizationExpiresAt ?? null,
        authorizationLapsedAt: projection.authorizationLapsedAt ?? null,
        nonAttendanceMarkedAt: projection.nonAttendanceMarkedAt ?? null,
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
        append: (evts, projection) => appendFor(trxDb, evts, projection),
        countLiveHoldsForAgent: (agentId) => countLiveHoldsFor(trxDb, agentId),
        lockAgent: async (agentId) => {
          // pg_advisory_xact_lock: held until this transaction commits or
          // rolls back, and serializes against any other transaction taking
          // the same key — including another connection's hold_slot call
          // for this same agentId. hashtext() folds the string key to the
          // bigint pg_advisory_xact_lock needs.
          await trxDb.execute(sql`select pg_advisory_xact_lock(hashtext(${agentId}))`)
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

  async countLiveHoldsForAgent(agentId: string): Promise<number> {
    return countLiveHoldsFor(this.db, agentId)
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
}

async function countLiveHoldsFor(db: Queryable, agentId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.agentId, agentId), eq(bookings.status, 'held')))
  return rows[0]?.count ?? 0
}

