-- Slice 5: idempotency marker for the no-show-eligibility worker, mirroring
-- authorization_lapsed_at's role for the authorisation-lapse worker. Trimmed
-- from drizzle-kit's raw `generate` output, which also proposed dropping and
-- recreating the (unchanged) event_type enum — a no-op churn this migration
-- doesn't need.
ALTER TABLE "bookings" ADD COLUMN "no_show_eligible_marked_at" timestamp with time zone;
