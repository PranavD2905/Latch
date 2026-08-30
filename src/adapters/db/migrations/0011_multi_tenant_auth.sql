-- Real multi-tenant auth: per-merchant credentials (replacing the single
-- static MERCHANT_API_TOKEN/AUDIT_TRAIL_TOKEN env vars), plus tenant-scoping
-- columns on bookings/events so reads (the audit trail, agent rate/hold
-- bounds) can be scoped to the merchant that owns them instead of assuming a
-- single deployment-wide tenant. Supersedes docs/01-architecture.md §10's
-- "Not multi-tenant" non-goal — see docs/07-deployment.md for the new model.

CREATE TABLE "merchant_credentials" (
  "token_prefix" text PRIMARY KEY,
  "merchant_id" text NOT NULL REFERENCES "merchants"("merchant_id"),
  "token_hash" text NOT NULL,
  "scope" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "revoked_at" timestamptz
);
CREATE INDEX "merchant_credentials_merchant_id_idx" ON "merchant_credentials" ("merchant_id");
-- At most one *active* credential per (merchant, scope) — rotation revokes
-- the old row (revoked_at set) rather than deleting it, then inserts a new
-- one; the partial index only ever blocks two simultaneously-active rows for
-- the same merchant+scope, never a revoked row sitting alongside a new one.
CREATE UNIQUE INDEX "merchant_credentials_one_active_per_scope" ON "merchant_credentials" ("merchant_id", "scope") WHERE "revoked_at" IS NULL;

ALTER TABLE "bookings" ADD COLUMN "merchant_id" text;
ALTER TABLE "events" ADD COLUMN "merchant_id" text;

-- Backfill: every row that exists before this migration runs was created
-- back when this deployment had exactly one merchant
-- (docs/01-architecture.md §10, true up to this exact migration) — so
-- backfilling to that one seed merchant id is not a guess, it's a fact about
-- this system's history. A fresh deployment has no rows yet; this is a no-op
-- there.
UPDATE "bookings" SET "merchant_id" = 'mer_clinic' WHERE "merchant_id" IS NULL;
UPDATE "events" SET "merchant_id" = 'mer_clinic' WHERE "merchant_id" IS NULL;

ALTER TABLE "bookings" ALTER COLUMN "merchant_id" SET NOT NULL;
ALTER TABLE "events" ALTER COLUMN "merchant_id" SET NOT NULL;

CREATE INDEX "bookings_merchant_id_idx" ON "bookings" ("merchant_id");
-- The SSE audit-trail feed's hot query, now scoped: this merchant's events,
-- in true insertion order.
CREATE INDEX "events_merchant_global_sequence_idx" ON "events" ("merchant_id", "global_sequence");
