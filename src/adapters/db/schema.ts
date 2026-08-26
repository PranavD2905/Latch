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
  'RECONCILIATION_MISMATCH',
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
    /**
     * Migration 0011 — which merchant this event belongs to. Stamped at
     * append time from the request's authenticated `AppDeps.merchantId`
     * (or, for background-worker/webhook appends against an existing
     * booking, from that booking's own `BookingSnapshot.merchantId` — never
     * re-derived by inference). This is what makes the SSE audit-trail feed
     * (`src/adapters/audit-trail/server.ts`) safe to scope per tenant: a
     * viewer authenticated as merchant A can never see merchant B's events,
     * enforced by an indexed `WHERE`, not by trusting the query never to ask.
     */
    merchantId: text('merchant_id').notNull(),
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
  /**
   * Migration 0011 — same tenant-scoping role as `events.merchantId` above.
   * Denormalised onto the projection (rather than derived via a join through
   * `practitioners`) so every hot-path read that already hits this table —
   * the agent hold-count/rate bounds, `get_booking`, the merchant-API's
   * decline/mark-no-show lookups — can filter by tenant with the same
   * indexed query it already runs, instead of a second join per request.
   */
  merchantId: text('merchant_id').notNull(),
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
    /** dev-logs/014, gap 2: the request-rate ceiling — see `src/domain/policy.ts`'s `holdRateLimitPerMinute` doc comment. */
    holdRateLimitPerMinute: integer('hold_rate_limit_per_minute').notNull().default(10),
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

// ---------------------------------------------------------------------------
// merchant_credentials — migration 0011. Real multi-tenant auth: replaces
// the single static `MERCHANT_API_TOKEN`/`AUDIT_TRAIL_TOKEN` env vars with
// per-merchant, DB-issued API keys. Never stores the plaintext token — only
// a SHA-256 hash, looked up by an indexed public prefix (same shape as
// Stripe's `sk_live_...`: the prefix is safe to log/index, the suffix is the
// actual secret material, hashed at rest). `scope` distinguishes a
// merchant-API credential from an audit-trail-viewer credential — the two
// grant access to different surfaces and are issued/rotated independently.
// See `src/adapters/auth/merchant-credentials.ts` for issuance/verification.
// ---------------------------------------------------------------------------

// A merchant may hold at most one *active* credential per scope — enforced
// by a partial unique index (`WHERE revoked_at IS NULL`) in the migration,
// same reason `one_live_booking_per_slot` (docs/01-architecture.md §4) lives
// in raw SQL rather than here: Drizzle's schema DSL has no native support
// for an indexed WHERE clause. A plain `unique(merchantId, scope)` would
// block rotation outright — the old row must stay (revoked, not deleted) so
// "was this token ever valid" stays answerable — so it is deliberately not
// declared here.
export const merchantCredentials = pgTable('merchant_credentials', {
  tokenPrefix: text('token_prefix').primaryKey(),
  merchantId: text('merchant_id')
    .notNull()
    .references(() => merchants.merchantId),
  tokenHash: text('token_hash').notNull(),
  scope: text('scope').notNull(), // 'merchant_api' | 'audit_trail'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  /** Null while active. Revocation is a soft-delete — never DELETE a credential row. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

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

/** dev-logs/016 — see `src/ports/webhook-dead-letter-store.ts` for why this exists. */
export const webhookDeadLetters = pgTable('webhook_dead_letters', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  event: text('event').notNull(),
  entityId: text('entity_id').notNull(),
  payload: jsonb('payload').notNull(),
  lastError: text('last_error').notNull(),
  attemptCount: integer('attempt_count').notNull(),
  firstFailedAt: timestamp('first_failed_at', { withTimezone: true }).notNull(),
  lastFailedAt: timestamp('last_failed_at', { withTimezone: true }).notNull(),
  deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
})

export const practitionersRelations = relations(practitioners, ({ one }) => ({
  merchant: one(merchants, { fields: [practitioners.merchantId], references: [merchants.merchantId] }),
}))

export const servicesRelations = relations(services, ({ one }) => ({
  merchant: one(merchants, { fields: [services.merchantId], references: [merchants.merchantId] }),
}))

export const policiesRelations = relations(policies, ({ one }) => ({
  merchant: one(merchants, { fields: [policies.merchantId], references: [merchants.merchantId] }),
}))
