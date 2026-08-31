-- Removes the no-show feature's schema surface — a market-fit decision, not
-- a simplification: a post-hoc debit against a stored card is a Western
-- import Indian merchants don't actually use. The cancellation ladder's own
-- `hoursBefore: 0` floor tier (full deposit forfeiture) is the recovery
-- mechanism Indian merchants already reach for, and needed no new schema at
-- all. See the dev log for this removal.
--
-- WHY THIS IS SAFE
--
-- `policies` is append-only (0010_policies_immutable.sql), guarded by a
-- trigger on UPDATE/DELETE — this migration is DDL (ALTER TABLE ... DROP
-- COLUMN), which that row-level trigger never fires for, so no workaround is
-- needed here.
--
-- `bookings` is a disposable projection, not the source of truth (fold.ts's
-- own doc comment: "everything here is computable by replaying events").
-- Dropping its no-show-only columns loses no history — whatever a
-- pre-removal booking's own no-show authorisation actually was still lives
-- permanently in that booking's `events.payload` rows, exactly as event-
-- sourcing promises. The event type catalogue (`event_type` enum) and the
-- booking-status enum both keep every no-show-era value they ever had —
-- `AUTHORIZATION_HELD`, `NO_SHOW_CHARGED`, `no_show_charged`, and the rest —
-- untouched: an already-recorded historical fact must stay readable forever,
-- and there is no code-level reason to force the invasive enum-recreation
-- Postgres would require to strip a value nothing new can ever produce again.

ALTER TABLE "policies" DROP COLUMN "no_show_fee_paise";
ALTER TABLE "policies" DROP COLUMN "no_show_grace_minutes";

ALTER TABLE "bookings" DROP COLUMN "authorization_id";
ALTER TABLE "bookings" DROP COLUMN "authorization_amount_paise";
ALTER TABLE "bookings" DROP COLUMN "authorization_expires_at";
ALTER TABLE "bookings" DROP COLUMN "authorization_lapsed_at";
ALTER TABLE "bookings" DROP COLUMN "non_attendance_marked_at";
ALTER TABLE "bookings" DROP COLUMN "no_show_eligible_marked_at";
