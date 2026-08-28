-- dev-logs/021: indexes the idempotency cleanup worker's GC query
-- (WHERE created_at < cutoff), so it isn't a full table scan as this table
-- grows. See src/adapters/db/postgres-idempotency-store.ts's deleteExpired.
CREATE INDEX IF NOT EXISTS "idempotency_keys_created_at_idx" ON "idempotency_keys" ("created_at");
