-- The session-complete leg: a second, independent authorization/capture
-- mandate alongside the existing no-show one — (service.pricePaise -
-- policy.depositAmountPaise), authorised at confirm time, captured when the
-- merchant marks the session complete. The no-show fee itself becomes fully
-- optional. See dev-logs entry for this slice.

ALTER TABLE "bookings" ADD COLUMN "session_complete_authorization_id" text;
ALTER TABLE "bookings" ADD COLUMN "session_complete_authorization_amount_paise" integer;
ALTER TABLE "bookings" ADD COLUMN "session_complete_authorization_expires_at" timestamptz;
ALTER TABLE "bookings" ADD COLUMN "session_complete_authorization_lapsed_at" timestamptz;

-- services.updatedAt — new, merchant-editable pricing (PATCH /services/:id)
-- needs a real "last changed" marker the same way bookings/policies already
-- carry one. Backfilled to createdAt for existing rows.
ALTER TABLE "services" ADD COLUMN "updated_at" timestamptz;
UPDATE "services" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
ALTER TABLE "services" ALTER COLUMN "updated_at" SET NOT NULL;

-- No-show fee/grace are now optional together — see src/domain/policy.ts
-- and src/domain/policy-validation.ts's NO_SHOW_FIELDS_MUST_BE_PAIRED rule.
ALTER TABLE "policies" ALTER COLUMN "no_show_fee_paise" DROP NOT NULL;
ALTER TABLE "policies" ALTER COLUMN "no_show_grace_minutes" DROP NOT NULL;

ALTER TYPE "event_type" ADD VALUE 'SESSION_COMPLETE_AUTHORIZATION_HELD';
ALTER TYPE "event_type" ADD VALUE 'SESSION_COMPLETE_AUTHORIZATION_RELEASED';
ALTER TYPE "event_type" ADD VALUE 'SESSION_COMPLETE_AUTHORIZATION_LAPSED';
ALTER TYPE "event_type" ADD VALUE 'SESSION_COMPLETE_CHARGED';
