# Dev Log 003 — Slice 0: skeleton and event store

**Date:** 23 August 2026
**Phase:** Slice 0 (`prompts/slice-0.md`)
**Status:** Done — all four acceptance criteria pass under `npm test`

---

## What was built

- Repo skeleton: `package.json`, `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), hexagonal directory layout (`src/domain`, `src/ports`,
  `src/adapters`, `src/app`).
- `Money`: branded `Paise` type (`src/domain/money.ts`) — constructor, arithmetic, and
  `floorPercentageOf` (the ladder's floor-division rule, without the ladder evaluator itself,
  which is Slice 1 scope).
- `Clock` port (`src/ports/clock.ts`) with `SystemClock` and `FrozenClock`
  (`src/adapters/clock/`).
- Event catalogue (`src/domain/events.ts`): all 16 documented event types as a discriminated
  union, plus one added during this slice (see below). The four money-moving events
  (`DEPOSIT_CAPTURED`, `RETENTION_APPLIED`, `REFUND_ISSUED`, `NO_SHOW_CHARGED`) additionally
  carry `MoneyFields` (`action`/`gate`/`bound`/`authority`).
- Constructors (`src/domain/event-factory.ts`): one factory per event type, generic over the
  event's own type so a money event's `fields` argument is inferred as exactly
  `action | gate | bound | authority` — passing an incomplete object fails to compile.
- `fold()` (`src/domain/fold.ts`): pure reducer, sorts by `sequence`, replays the full state
  machine from `docs/03-domain-model.md` §3.
- Postgres schema (`src/adapters/db/schema.ts`) via Drizzle: `events`, `bookings`, `merchants`,
  `practitioners`, `services`, `policies`. Two migrations: `0000_...` (generated from schema),
  `0001_partial_unique_index_one_live_booking_per_slot.sql` (hand-written raw SQL, via
  `drizzle-kit generate --custom` — confirmed Drizzle's schema DSL has no way to express an
  indexed `WHERE` clause, matching what the prompt already said).

## Test coverage — the four acceptance criteria

1. `npm test` passes (29 tests; `tsc --noEmit && vitest run`).
2. `fold.test.ts` — `HOLD_CREATED` alone folds to `HELD` (plus five more scenarios: full
   confirm path, the merchant-decline trace, no-show-charged, out-of-order events, empty/mixed
   input rejection).
3. `events.test.ts` — two `@ts-expect-error` cases: a `DepositCapturedEvent` object literal
   missing `bound`, and a factory call missing `authority`. Both fail to compile without the
   directive, proving the directive is load-bearing and not just present.
4. `schema.integration.test.ts` — inserts two `bookings` rows with the same
   `(practitioner_id, starts_at)` while both are `held`/`confirmed`; the second insert throws
   `duplicate key value violates unique constraint "one_live_booking_per_slot"`. A third case
   confirms a new live booking is allowed once the first is no longer live (status changed away
   from held/confirmed).
5. `money.test.ts` — `@ts-expect-error` on assigning a raw `number` to `Paise`.

## Things that surprised me

**A real Postgres was already running on this machine, on the same port I tried to put a
Docker container on — and the failure mode was silent and misleading.** `docker run -p
5432:5432 postgres:16-alpine` succeeded, but every connection from `postgres.js` (even with
explicit `{ username: 'latch', password: 'latch' }`, not just a URL) failed with `role "latch"
does not exist`. The actual cause: Postgres.app (Postgres 18) was already listening on
`127.0.0.1:5432` and `[::1]:5432`. Docker Desktop's port-forwarding proxy binds `*:5432` (every
interface), but macOS resolves `localhost` to the loopback addresses first, so every connection
was quietly landing on the pre-existing native server, not the container — which of course had
no `latch` role. Fixed by dropping the Docker container entirely and creating the `latch`
role/database directly on Postgres.app instead.

This turned out to double-confirm a decision already in `docs/02-tech-stack.md` §15 that I
almost violated: the docs explicitly reject "Docker Compose for dev," reasoning "one Postgres
URL in `.env` is enough; containers slow iteration." I'd started writing a `docker-compose.yml`
before catching this against the docs and switching to `docker run` — then discovered even that
was unnecessary once I found the native instance. **Lesson for future sessions: check for an
already-running Postgres before reaching for Docker at all.**

**A gap between the state diagram and the event catalogue.** `docs/03-domain-model.md` §3's
diagram has "merchant marks attended → `COMPLETED`," but §4's event catalogue (16 events) had
no event for that transition. Added `BOOKING_COMPLETED` (non-money) to both the catalogue table
and the `BookingEvent` union, and to `fold()`. No behavior in the brief depends on the exact
name — this is a bookkeeping event, not a money one — so this was a safe, mechanical fix rather
than a judgment call.

**"Never update a booking's state" needed a clarifying line.** Taken literally, that phrase from
`01-architecture.md` reads as "no SQL `UPDATE` anywhere," which can't be right — the `bookings`
projection has a `status` column that must change over the booking's lifetime for the partial
unique index to mean anything (a `held` row has to later read as `cancelled_by_customer`, on the
*same* `booking_id` row, or the index's `WHERE` clause has nothing to scope against). Added a
clarifying paragraph to `docs/03-domain-model.md` §1: the rule is about the `events` table being
append-only and the projection never being written to *without* a causing event in the same
transaction — not a ban on `UPDATE` as a SQL verb.

## Decisions made that the docs did not settle

- **DB driver: `postgres` (postgres.js), not `pg`.** The tech-stack doc names Drizzle vs. Prisma
  but not the underlying driver. Chose postgres.js for the plain promise-based API and because
  it's the driver most Drizzle examples assume.
- **Event/booking IDs: ULID via the `ulid` package.** The prompt said "ULID or UUIDv7 — sortable
  by time" without picking one; ULID is lexicographically sortable as a string and has a
  smaller, more explicit reference implementation than most UUIDv7 packages at the time of
  writing.
- **Env loading: Node's built-in `process.loadEnvFile()`, not `dotenv`.** Available unflagged on
  Node ≥21.7 (we're on 22.23.1). One fewer dependency, and consistent with the tech-stack doc's
  "fewer moving parts" bias.
- **`npm test` runs `tsc --noEmit` before `vitest run`.** Vitest transpiles TypeScript with
  esbuild, which strips types without checking them — a bare `vitest run` would silently no-op
  every `@ts-expect-error` in the suite. Since two of the four acceptance criteria for this
  slice *are* `@ts-expect-error` assertions, `npm test` has to actually typecheck or the
  acceptance bar is fake.
- **Test-DB dependency for `npm test`.** The integration test needs a live Postgres with
  migrations applied (`npm run db:migrate` once, using whatever `DATABASE_URL` is in `.env`). No
  test-database isolation/teardown-per-run beyond the test file's own `afterAll` cleanup was
  built — acceptable for a one-developer, one-environment buildathon timeline, revisit if that
  changes.

## Carried forward

- Everything in dev-log 002's carry-forward list (mandate registration verification, UPI
  Autopay pricing, changelog re-check before submission) is unchanged — not touched this slice.
- `Slice 1` can now build `find_slots`, `get_policy`, `hold_slot`, `confirm_with_deposit` against
  a `FakePaymentProvider`, and the ladder evaluator itself (using `floorPercentageOf`, already
  built here) with boundary tests on `FrozenClock`.
