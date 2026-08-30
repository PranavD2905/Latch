CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_unique" UNIQUE("scope","key")
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "hold_expires_at" timestamp with time zone;