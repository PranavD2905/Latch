-- dev-logs/016: `POST /webhooks/razorpay`'s dead-letter surface. See
-- `src/ports/webhook-dead-letter-store.ts`.
--
-- Hand-edited from what `drizzle-kit generate` produced: the generator's
-- own snapshot chain jumped straight from `0009_snapshot.json` to this
-- migration because 0010 and 0011 were both hand-written directly (the
-- same gap dev-logs/010 already flagged once) rather than run through
-- `drizzle-kit generate` — so its diff was computed against schema state
-- from *before* those two migrations and included their changes a second
-- time (re-`CREATE TABLE merchant_credentials`, re-`ALTER TABLE bookings/
-- events ADD COLUMN merchant_id`). Those statements are already applied;
-- only the table below is genuinely new. The generated `0012_snapshot.json`
-- itself is correct (it's schema.ts's actual current state, not a diff) and
-- was kept as-is so the next `db:generate` diffs from here forward, not
-- from 0009 again.
CREATE TABLE IF NOT EXISTS "webhook_dead_letters" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"last_error" text NOT NULL,
	"attempt_count" integer NOT NULL,
	"first_failed_at" timestamp with time zone NOT NULL,
	"last_failed_at" timestamp with time zone NOT NULL,
	"dead_lettered_at" timestamp with time zone
);
