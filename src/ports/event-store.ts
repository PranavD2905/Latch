import type { BookingEvent, PaymentRequestedLeg } from '../domain/events.js'
import type { BookingStatus } from '../domain/fold.js'
import type { Paise } from '../domain/money.js'

/**
 * The `bookings` projection row, as read/written by the store. Mirrors
 * `src/adapters/db/schema.ts`'s `bookings` table plus the two columns this
 * slice adds (`agentId`, `holdExpiresAt`) — see the Slice 1 migration.
 */
export interface BookingSnapshot {
  bookingId: string
  /** Migration 0011 — which merchant owns this booking. Set once, at `hold_slot` time, from the authenticated request's merchant; every later projection update just carries it forward unchanged. */
  merchantId: string
  practitionerId: string
  serviceId: string
  startsAt: Date
  status: BookingStatus
  policyVersion: number | undefined
  /**
   * The session-complete mandate — `sessionCompleteAuthorizationAmountPaise`
   * is `service.pricePaise - policy.depositAmountPaise`, frozen at confirm
   * time. (The no-show leg used to mirror these four fields as a separate
   * `authorization*` set — removed along with the no-show feature; see the
   * dev log for that removal. The permanent `events` table still carries
   * whatever a pre-removal booking's own no-show authorisation actually was,
   * this disposable projection just no longer tracks it.)
   */
  sessionCompleteAuthorizationId: string | undefined
  sessionCompleteAuthorizationAmountPaise: Paise | undefined
  sessionCompleteAuthorizationExpiresAt: Date | undefined
  sessionCompleteAuthorizationLapsedAt: Date | undefined
  agentId: string | undefined
  /** Set only while status is HELD — when the hold's TTL expires. */
  holdExpiresAt: Date | undefined
  /**
   * The payment-link feature — whichever legs `confirm_with_deposit` most
   * recently issued a pay link for and is still waiting on. `undefined` once
   * there's nothing pending (never issued, or already resolved into
   * `CONFIRMED`). `GET /pay/:bookingId` (`audit-trail/server.ts`)
   * resolves a link's amount/order/label from here — see dev-logs entry for
   * this feature on why the URL itself never carries an authoritative amount.
   */
  pendingPaymentLegs: readonly PaymentRequestedLeg[] | undefined
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
   * corresponding `bookings` row. `merchantId` is always explicit — even
   * when `projection` is present and already carries its own `merchantId` —
   * rather than read off the projection, so every call site names its
   * tenant the same way `deps.clock`/`deps.merchantId` are always named
   * explicitly elsewhere in this codebase, and a refusal with no projection
   * still has somewhere to get it from (migration 0011).
   */
  append(events: readonly BookingEvent[], projection: BookingSnapshot | undefined, merchantId: string): Promise<void>
  /** How many bookings this agent currently has HELD for this merchant — read inside the transaction, after `lockAgent`. Scoped by merchant (migration 0011) so an `agentId` string reused across two unrelated merchants never shares a bound. */
  countLiveHoldsForAgent(merchantId: string, agentId: string): Promise<number>
  /**
   * A Postgres advisory lock (`pg_advisory_xact_lock`), scoped to `key` and
   * held for the lifetime of this transaction — released automatically on
   * commit or rollback. docs/01-architecture.md §1 Idea 3 claims the
   * concurrent-holds-per-agent bound is enforced by "Latch + DB constraint,"
   * not just app logic (the "No — DB constraint" column). A plain
   * count-then-insert has a race: two concurrent `hold_slot` calls from the
   * same agent can both read a count under the limit before either inserts.
   * Calling `lockAgent(merchantId, agentId)` first serializes every
   * `hold_slot` attempt from the same agent *against the same merchant*
   * through this transaction, closing that race — exactly the DB-level
   * guarantee the docs claim. See dev-logs/004. Keyed on `(merchantId,
   * agentId)`, not `agentId` alone (migration 0011): an `agentId` is a
   * caller-supplied string with no global-uniqueness guarantee, so without
   * the merchant in the lock key, one agent transacting with two unrelated
   * merchants — or two different agents that happen to reuse the same id
   * string at different merchants — would serialize against each other for
   * no reason, and worse, would share the same concurrent-hold/rate-limit
   * bound across tenants that have nothing to do with each other.
   */
  lockAgent(merchantId: string, agentId: string): Promise<void>
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
   * dev-logs/014, gap 2: how many `HOLD_CREATED` events this agent has
   * accumulated since `since` (any current booking status — a
   * released/expired hold still counts, since the point is request *rate*,
   * not current live count). Compared against `since` on the *domain*
   * clock's timeline (`events.occurredAt`, from `Clock.now()`), not DB
   * wall-clock insert time — see the Postgres adapter's own comment for why
   * that distinction matters. The request-rate ceiling's read, taken inside
   * the same `lockAgent` transaction `hold_slot` already opens for the
   * concurrent-hold check, so the two bounds are enforced atomically against
   * the same serialised window per agent.
   */
  countBookingsCreatedByAgentSince(merchantId: string, agentId: string, since: Date): Promise<number>
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

  /**
   * Read-only, unlocked — the top-level twin of `EventStoreTx.loadEvents`,
   * for callers that need one booking's history outside any transaction
   * (dev-logs/014: the reconciliation worker and the webhook handler both
   * read history strictly outside a DB lock, the same discipline every
   * payment-call site in this codebase already follows — never hold a row
   * lock across a network call, and a Razorpay lookup is a network call).
   */
  loadEvents(bookingId: string): Promise<readonly BookingEvent[]>

  /**
   * CONFIRMED bookings — the reconciliation worker's candidate list
   * (docs/01-architecture.md §8, dev-logs/014). Read-only, unlocked; the
   * worker re-locks each candidate individually before appending a finding,
   * exactly the two-transaction shape `confirm_with_deposit`/`decline_booking`
   * already use around a real payment-provider network call.
   */
  listOpenBookingsForReconciliation(limit: number): Promise<readonly BookingSnapshot[]>

  /** Live (held/confirmed) booking intervals for a practitioner in `[from, to)` — slot computation input. */
  listLiveIntervals(practitionerId: string, from: Date, to: Date): Promise<readonly BusyInterval[]>

  /** How many bookings this agent currently has HELD for this merchant — the concurrent-hold gate. Merchant-scoped, see `EventStoreTx.countLiveHoldsForAgent`. */
  countLiveHoldsForAgent(merchantId: string, agentId: string): Promise<number>

  /**
   * CONFIRMED bookings whose session-complete mandate has passed `expiresAt`
   * but have not yet had that fact recorded (`sessionCompleteAuthorizationLapsedAt`
   * unset). The authorisation-lapse worker's input — docs/01-architecture.md
   * §8. (Used to have a no-show-leg twin, `listConfirmedBookingsWithExpiredAuthorization`
   * — removed along with the no-show feature.)
   */
  listConfirmedBookingsWithExpiredSessionCompleteAuthorization(now: Date): Promise<readonly BookingSnapshot[]>

  /**
   * Every event across every booking, oldest first — Slice 6's SSE audit
   * trail feed (prompts/slice-6.md item 1: "streaming events as they are
   * appended"). Ordered and paged by the `events` table's `globalSequence`
   * column (`schema.ts`), a `bigserial` that is literally row-insertion
   * order — deliberately not `occurredAt` (a domain timestamp off the
   * `Clock` port; integration tests legitimately run a `FrozenClock` far
   * into the future to simulate elapsed time, and those rows land for real
   * in the shared dev database, which would poison any ordering/cursor
   * built on `occurredAt`) and not `eventId` (a ULID's sub-millisecond
   * ordering is random, not causal — a multi-event transaction like
   * `decline_booking`'s five-event write appends all its rows within the
   * same millisecond, so sorting by `eventId` alone visibly shuffled them
   * when this was live-tested against a real decline). Pass `afterGlobalSequence`
   * (a previously-seen event's own value) to fetch only what's new since —
   * the same call serves both "replay everything on connect" (omit it) and
   * "catch up after a reconnect."
   *
   * Scoped to one `merchantId` (migration 0011) — the SSE feed is
   * per-tenant, so this is the enforcement point that makes "merchant A's
   * viewer can never see merchant B's events" a query-level guarantee (an
   * indexed `WHERE merchant_id = ...`), not just something the caller is
   * trusted to filter after the fact.
   */
  listAllEvents(merchantId: string, afterGlobalSequence?: number): Promise<readonly EventWithGlobalSequence[]>

  /**
   * Resolves a bare `eventId` (all the SSE protocol's `Last-Event-ID`
   * header can carry) to its `globalSequence` — the one spot a reconnecting
   * browser hands the server less than a full cursor. Scoped to `merchantId`
   * so a reconnecting viewer can't use `Last-Event-ID` to fast-forward to
   * (or merely confirm the existence of) another merchant's event.
   */
  findGlobalSequence(merchantId: string, eventId: string): Promise<number | undefined>
}

/** One `listAllEvents` row: the event plus the insertion-order cursor value it landed at. */
export interface EventWithGlobalSequence {
  event: BookingEvent
  globalSequence: number
}
