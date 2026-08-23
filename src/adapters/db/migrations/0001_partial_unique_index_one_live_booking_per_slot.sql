-- The load-bearing constraint. docs/01-architecture.md §4, docs/03-domain-model.md §1.
--
-- A plain unique index on (practitioner_id, starts_at) would break the moment
-- one booking for a slot is cancelled and a later booking is made for the same
-- slot — two rows, same tuple, one of them dead history. The WHERE clause scopes
-- uniqueness to only the rows that are currently live, so cancelled/expired
-- bookings never conflict with a new booking of the same slot.
--
-- Two concurrent transactions racing to hold/confirm the same slot: the second
-- writer's INSERT fails at the database with a unique_violation. There is no
-- window between "check" and "write" for the race to land in, because there is
-- no separate check — the constraint IS the check, enforced atomically by Postgres.
CREATE UNIQUE INDEX "one_live_booking_per_slot"
  ON "bookings" ("practitioner_id", "starts_at")
  WHERE "status" IN ('held', 'confirmed');
