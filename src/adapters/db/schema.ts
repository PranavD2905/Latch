import { relations } from 'drizzle-orm'
import { bigserial, integer, jsonb, pgEnum, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Enums — mirrors of the domain's discriminated union and state machine.
// Keeping them as enums (not free text) means Postgres itself rejects a typo'd
// event type or status, on top of what TypeScript already rejects.
// ---------------------------------------------------------------------------

export const eventTypeEnum = pgEnum('event_type', [
  'HOLD_CREATED',
  'HOLD_EXPIRED',
  'HOLD_RELEASED',
  'POLICY_ACKNOWLEDGED',
  'DEPOSIT_CAPTURED',
  'AUTHORIZATION_HELD',
  'BOOKING_CONFIRMED',
  'BOOKING_RESCHEDULED',
  'CANCELLED_BY_CUSTOMER',
  'RETENTION_APPLIED',
  'REFUND_ISSUED',
  'MERCHANT_DECLINED',
  'SLOT_RELEASED',
  'AUTHORIZATION_RELEASED',
  'AUTHORIZATION_LAPSED',
  'ALTERNATIVES_OFFERED',
  'NO_SHOW_ELIGIBLE',
  'NON_ATTENDANCE_MARKED',
  'NO_SHOW_CHARGED',
  'BOOKING_COMPLETED',
  'ACTION_REFUSED',
])

export const bookingStatusEnum = pgEnum('booking_status', [
  'held',
  'expired',
  'released',
  'confirmed',
  'cancelled_by_customer',
  'declined_by_merchant',
  'no_show_eligible',
  'no_show_charged',
  'completed',
])

// ---------------------------------------------------------------------------
// events — append-only. Never UPDATEd, never DELETEd. The source of truth.
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    eventId: text('event_id').primaryKey(),
    bookingId: text('booking_id').notNull(),
    type: eventTypeEnum('type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    sequence: integer('sequence').notNull(),
    /** The full event object (action/gate/bound/authority included, for money events). */
    payload: jsonb('payload').notNull(),
    /**
     * Slice 6: true row-insertion order, independent of `occurredAt`.
     * `occurredAt` comes from the `Clock` port, and integration tests
     * legitimately advance a `FrozenClock` far into the future to simulate
     * elapsed time (e.g. `NO_SHOW_ELIGIBLE`) — those rows land for real in
     * the shared dev database with a domain timestamp nowhere near actual
     * insertion time. The audit-trail SSE feed needs "as they are appended"
     * literally (prompts/slice-6.md item 1), so it orders and pages by this
     * column, never by `occurredAt`.
     */
    globalSequence: bigserial('global_sequence', { mode: 'number' }).notNull(),
  },
  (table) => [
    // One sequence number per booking, exactly once — makes a gap or a
    // duplicate append fail loudly instead of silently corrupting the fold order.
    unique('events_booking_sequence_unique').on(table.bookingId, table.sequence),
  ],
)

// ---------------------------------------------------------------------------
// bookings — projection. Derived from events, kept only for fast reads and to
// carry the partial unique index. Written alongside the event, same transaction.
// The partial unique index itself is NOT expressible in Drizzle's schema DSL
// (no native support for an indexed WHERE clause here) — it lives in a raw
// migration file instead. See migrations/, and docs/01-architecture.md §4.
// ---------------------------------------------------------------------------

export const bookings = pgTable('bookings', {
  bookingId: text('booking_id').primaryKey(),
  practitionerId: text('practitioner_id').notNull(),
  serviceId: text('service_id').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  status: bookingStatusEnum('status').notNull(),
  policyVersion: integer('policy_version'),
  /**
   * Slice 4: the no-show authorisation currently held against this booking,
   * and when it lapses / whether that lapse has been recorded — needed for
   * `charge_no_show`'s gate and the authorisation-lapse worker without a
   * full event replay. Renamed from the Slice 0-1 scaffolding's `mandateId`
   * (dev-logs/005/006: the mandate design was replaced by card manual
   * capture before it was ever used for real).
   */
  authorizationId: text('authorization_id'),
  authorizationAmountPaise: integer('authorization_amount_paise'),
  authorizationExpiresAt: timestamp('authorization_expires_at', { withTimezone: true }),
  authorizationLapsedAt: timestamp('authorization_lapsed_at', { withTimezone: true }),
  /** Set by the merchant API's mark-no-show route — `charge_no_show`'s second independent fact. */
  nonAttendanceMarkedAt: timestamp('non_attendance_marked_at', { withTimezone: true }),
  /**
   * Slice 5: set once the no-show-eligibility worker has recorded
   * `NO_SHOW_ELIGIBLE` for this booking — the idempotency marker that stops
   * it firing twice, same role `authorizationLapsedAt` plays for the
   * authorisation-lapse worker. Deliberately does NOT gate `charge_no_show`
   * (dev-logs/009: its gate re-derives eligibility from the clock directly)
   * and setting it never changes `status` away from `confirmed` — see
   * `src/app/no-show-eligibility-worker.ts`.
   */
  noShowEligibleMarkedAt: timestamp('no_show_eligible_marked_at', { withTimezone: true }),
  /**
   * Slice 1 addition: which agent holds/confirmed this booking, and (while
   * status is 'held') when that hold's TTL expires. Both are needed for
   * gates that are otherwise untestable from the events table alone without
   * a full replay: `hold_slot`'s concurrent-hold-per-agent limit, and
   * `confirm_with_deposit`'s live-unexpired-hold check. See dev-logs/004.
   */
  agentId: text('agent_id'),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  lastEventSequence: integer('last_event_sequence').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

// ---------------------------------------------------------------------------
// Reference tables — one merchant, its practitioners, its services, and its
// versioned policy history. docs/03-domain-model.md §1-2.
// ---------------------------------------------------------------------------

export const merchants = pgTable('merchants', {
  merchantId: text('merchant_id').primaryKey(),
  name: text('name').notNull(),
  razorpayAccountId: text('razorpay_account_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

export const practitioners = pgTable('practitioners', {
  practitionerId: text('practitioner_id').primaryKey(),
  merchantId: text('merchant_id')
    .notNull()
    .references(() => merchants.merchantId),
  name: text('name').notNull(),
  /** e.g. { "mon": [["09:00","13:00"],["14:00","18:00"]], ... } — IST, computed against, never stored as slots. */
  workingHours: jsonb('working_hours').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

export const services = pgTable('services', {
  serviceId: text('service_id').primaryKey(),
  merchantId: text('merchant_id')
    .notNull()
    .references(() => merchants.merchantId),
  name: text('name').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  pricePaise: integer('price_paise').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

export const policies = pgTable(
  'policies',
  {
    policyId: text('policy_id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.merchantId),
    version: integer('version').notNull(),
    depositType: text('deposit_type').notNull(),
    depositAmountPaise: integer('deposit_amount_paise').notNull(),
    /** Ordered array of { hoursBefore, retainPct } — docs/03-domain-model.md §2. */
    cancellationLadder: jsonb('cancellation_ladder').notNull(),
    noShowFeePaise: integer('no_show_fee_paise').notNull(),
    noShowGraceMinutes: integer('no_show_grace_minutes').notNull(),
    holdTtlSeconds: integer('hold_ttl_seconds').notNull(),
    maxConcurrentHoldsPerAgent: integer('max_concurrent_holds_per_agent').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [unique('policies_merchant_version_unique').on(table.merchantId, table.version)],
)

// ---------------------------------------------------------------------------
// idempotency_keys — docs/01-architecture.md §6. `scope` is the tool name
// (`hold_slot`, `confirm_with_deposit`, ...); `key` is the caller-supplied
// idempotency key. A repeat of (scope, key) replays `response` rather than
// re-running the command. Only successful outcomes are stored — see
// src/ports/idempotency-store.ts.
// ---------------------------------------------------------------------------

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    response: jsonb('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [unique('idempotency_keys_scope_key_unique').on(table.scope, table.key)],
)

export const practitionersRelations = relations(practitioners, ({ one }) => ({
  merchant: one(merchants, { fields: [practitioners.merchantId], references: [merchants.merchantId] }),
}))

export const servicesRelations = relations(services, ({ one }) => ({
  merchant: one(merchants, { fields: [services.merchantId], references: [merchants.merchantId] }),
}))

export const policiesRelations = relations(policies, ({ one }) => ({
  merchant: one(merchants, { fields: [policies.merchantId], references: [merchants.merchantId] }),
}))
