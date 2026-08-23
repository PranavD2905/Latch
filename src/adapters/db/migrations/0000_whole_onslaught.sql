CREATE TYPE "public"."booking_status" AS ENUM('held', 'expired', 'released', 'confirmed', 'cancelled_by_customer', 'declined_by_merchant', 'no_show_eligible', 'no_show_charged', 'completed');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('HOLD_CREATED', 'HOLD_EXPIRED', 'HOLD_RELEASED', 'POLICY_ACKNOWLEDGED', 'DEPOSIT_CAPTURED', 'MANDATE_REGISTERED', 'BOOKING_CONFIRMED', 'BOOKING_RESCHEDULED', 'CANCELLED_BY_CUSTOMER', 'RETENTION_APPLIED', 'REFUND_ISSUED', 'MERCHANT_DECLINED', 'MANDATE_REVOKED', 'ALTERNATIVES_OFFERED', 'NO_SHOW_ELIGIBLE', 'NO_SHOW_CHARGED', 'BOOKING_COMPLETED', 'ACTION_REFUSED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bookings" (
	"booking_id" text PRIMARY KEY NOT NULL,
	"practitioner_id" text NOT NULL,
	"service_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"status" "booking_status" NOT NULL,
	"policy_version" integer,
	"mandate_id" text,
	"last_event_sequence" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"type" "event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"sequence" integer NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "events_booking_sequence_unique" UNIQUE("booking_id","sequence")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchants" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"razorpay_account_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policies" (
	"policy_id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"version" integer NOT NULL,
	"deposit_type" text NOT NULL,
	"deposit_amount_paise" integer NOT NULL,
	"cancellation_ladder" jsonb NOT NULL,
	"no_show_fee_paise" integer NOT NULL,
	"no_show_grace_minutes" integer NOT NULL,
	"mandate_ceiling_paise" integer NOT NULL,
	"hold_ttl_seconds" integer NOT NULL,
	"max_concurrent_holds_per_agent" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "policies_merchant_version_unique" UNIQUE("merchant_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "practitioners" (
	"practitioner_id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text NOT NULL,
	"working_hours" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "services" (
	"service_id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"price_paise" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "policies" ADD CONSTRAINT "policies_merchant_id_merchants_merchant_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("merchant_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_merchant_id_merchants_merchant_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("merchant_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_merchant_id_merchants_merchant_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("merchant_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
