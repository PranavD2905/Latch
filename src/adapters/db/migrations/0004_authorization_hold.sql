-- Slice 4: rename the Slice 0-1 scaffolding's mandate_id to authorization_id
-- (dev-logs/005/006 — the mandate design was replaced by card manual capture
-- before it was ever used for real) and add the columns charge_no_show's gate
-- and the authorisation-lapse worker need without a full event replay.
ALTER TABLE "bookings" RENAME COLUMN "mandate_id" TO "authorization_id";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "authorization_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "authorization_lapsed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "non_attendance_marked_at" timestamp with time zone;--> statement-breakpoint
-- Postgres cannot drop enum values (no native support without recreating the
-- type), so MANDATE_REGISTERED / MANDATE_REVOKED stay defined but unused —
-- nothing in the app constructs them any more. Cheaper and safer than a
-- rename-type/create-type/migrate-column/drop-type dance for zero benefit on
-- a dev database with no production rows.
ALTER TYPE "public"."event_type" ADD VALUE 'AUTHORIZATION_HELD' BEFORE 'BOOKING_CONFIRMED';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE 'AUTHORIZATION_LAPSED' BEFORE 'ALTERNATIVES_OFFERED';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE 'NON_ATTENDANCE_MARKED' BEFORE 'NO_SHOW_CHARGED';
