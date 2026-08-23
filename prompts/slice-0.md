# Slice 0 — Skeleton and event store

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Latch is a service-transaction layer that exposes an Indian service merchant (a dermatology clinic) to
any third-party AI agent over MCP. The product is the *money-and-time semantics* of an appointment —
slot holds, deposits, cancellation ladders, no-show charges — not the calendar. It is a Razorpay AI
Buildathon 2026 submission, Track 01.

**Design is complete. No code exists yet.** You are writing the first line.

## Read before writing any code

- `README.md`
- `docs/01-architecture.md` — especially §1 (the three shaping ideas) and §4 (concurrency)
- `docs/03-domain-model.md` — the whole thing; this slice implements its foundations
- `docs/02-tech-stack.md` §5, §6, §8 — Postgres, Drizzle, money type
- `docs/06-build-sequence.md` — find "Slice 0"; that is exactly your scope

## Settled decisions — do not re-open these

- TypeScript strict on Node 22. `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` all on.
- PostgreSQL + Drizzle ORM. Not Prisma, not SQLite — the reasoning is in `docs/02-tech-stack.md` §5–6.
- **Event-sourced.** The `events` table is the source of truth. Booking state is a fold over events.
  Never `UPDATE` a booking's state. The `bookings` table is a projection, written alongside the event
  in the same transaction, existing only to carry the unique index and make reads fast.
- **Money is branded integer paise.** Never a float, never rupees, never a plain `number`.
- **Ports and adapters.** The domain core imports nothing from HTTP, MCP, Razorpay, the database, or
  the system clock.
- Time comes only from a `Clock` port. `Date.now()` must not appear anywhere in the domain.

## Build this

**1. Project skeleton**
- `package.json`, `tsconfig.json` with the three strict flags above, Vitest configured
- Directory layout reflecting hexagonal architecture — suggested:
  `src/domain/` (pure), `src/ports/` (interfaces), `src/adapters/` (db, payment, clock),
  `src/app/` (command handlers wiring domain to ports)
- `.env.example` with `DATABASE_URL`

**2. The `Money` type**
```
type Paise = number & { readonly __brand: 'Paise' }
```
With constructors that validate integrality, and arithmetic helpers. A raw `number` must not be
assignable where `Paise` is expected — that is the entire point of the brand.

**3. The `Clock` port**
Interface with `now(): Date`. Two implementations: `SystemClock`, and `FrozenClock` that takes a fixed
instant and can be advanced. The frozen one is what makes ladder boundary tests deterministic in
Slice 1, so build it now.

**4. Database schema (Drizzle)**

`events` — append-only, never updated, never deleted:
- `event_id` (ULID or UUIDv7 — sortable by time)
- `booking_id`
- `type` (the event catalogue in `docs/03-domain-model.md` §4)
- `occurred_at` (from the Clock, always)
- `sequence` (monotonic per booking, for ordered folding)
- `payload` (jsonb)

`bookings` — projection:
- `booking_id`, `practitioner_id`, `starts_at`, `status`, plus denormalised fields for reads

**The partial unique index. Write it now — it shapes everything downstream:**
```
CREATE UNIQUE INDEX one_live_booking_per_slot
  ON bookings (practitioner_id, starts_at)
  WHERE status IN ('held', 'confirmed');
```
Drizzle will not express the `WHERE` clause natively. Put it in a raw migration. Do not skip it and do
not replace it with an application-level check — `docs/01-architecture.md` §4 explains why this
specific index is load-bearing.

Also seed tables for `merchants`, `practitioners`, `services`, `policies` (versioned).

**5. The event types — the most important part of this slice**

Implement the discriminated union from `docs/03-domain-model.md` §4. Money-moving events **must**
carry all four fields, and it must be impossible to construct one without them:

- `action` — direction, amount in `Paise`, instrument
- `gate` — which preconditions cleared, plus evidence
- `bound` — ceiling, and `enforced_by: 'latch_policy' | 'db_constraint' | 'razorpay_mandate'`
- `authority` — `policy_version`, plus mandate/payment ids where they exist

Prove the constraint holds: write a test file with a deliberately-broken construction and a
`@ts-expect-error` above it. If the code ever compiles without the error, the guarantee has silently
broken.

**6. The fold**
```
fold(events: Event[]): BookingState
```
Pure. Sorted by `sequence`. Implements the state machine in `docs/03-domain-model.md` §3.

## Done when

- `npm test` passes
- A test appends `HOLD_CREATED` and folds the booking to `HELD`
- A test proves a money event cannot be constructed without all four fields (`@ts-expect-error`)
- A test proves the partial unique index rejects a second live booking on the same
  `(practitioner_id, starts_at)` — insert twice, assert the second throws
- `Paise` cannot be assigned a raw `number` (another `@ts-expect-error`)

## Out of scope — do not build

MCP server, Razorpay, HTTP endpoints, the ladder evaluator, background workers, any UI. Those are
Slices 1–6.

## Before you finish

Write `dev-logs/003-<today>-slice-0-event-store.md` recording: what you built, anything that surprised
you, and any decision you made that the docs did not already settle. If you discovered something that
contradicts the docs, **update the docs** — later sessions read them as memory.
