import { relations } from 'drizzle-orm'
import { integer, jsonb, pgEnum, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'

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
  'MANDATE_REGISTERED',
  'BOOKING_CONFIRMED',
  'BOOKING_RESCHEDULED',
  'CANCELLED_BY_CUSTOMER',
  'RETENTION_APPLIED',
  'REFUND_ISSUED',
  'MERCHANT_DECLINED',
  'MANDATE_REVOKED',
  'ALTERNATIVES_OFFERED',
  'NO_SHOW_ELIGIBLE',
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
  mandateId: text('mandate_id'),
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
    mandateCeilingPaise: integer('mandate_ceiling_paise').notNull(),
    holdTtlSeconds: integer('hold_ttl_seconds').notNull(),
    maxConcurrentHoldsPerAgent: integer('max_concurrent_holds_per_agent').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [unique('policies_merchant_version_unique').on(table.merchantId, table.version)],
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
