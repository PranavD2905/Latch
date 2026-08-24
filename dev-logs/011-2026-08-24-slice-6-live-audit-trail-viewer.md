# Dev Log 011 — Slice 6: the live audit trail viewer

**Date:** 24 August 2026
**Phase:** Slice 6 (`prompts/slice-6.md`)
**Status:** Done — every "Done when" acceptance criterion verified against the real running system
(server + real Postgres + `FakePaymentRail`, `PAYMENT_PROVIDER` unset). `npm test` passes 119 tests clean.
Visual verification (screenshots) is the one thing this session could **not** complete — see the callout
below before assuming the UI has been eyeballed.

---

## What was built

- **`listAllEvents` / `findGlobalSequence`** (`src/ports/event-store.ts`,
  `src/adapters/db/postgres-event-store.ts`) — new `EventStore` methods, the SSE feed's read side.
- **`events.global_sequence`, a `bigserial` column** (`src/adapters/db/schema.ts`, migration `0008`) —
  true row-insertion order for the `events` table, independent of any domain field. Why this exists,
  rather than ordering by something already on the row, is the one real bug this slice caught; see
  below. `docs/03-domain-model.md` §4 updated with the same explanation, since it's exactly the kind of
  thing the next session needs to know before touching the event log's ordering again.
- **The audit-trail SSE server** (`src/adapters/audit-trail/server.ts` + `http.ts`, `npm run
  audit-trail:dev`, port 4002 by default) — one Fastify route, `GET /events`, same shape as
  `merchant-api`'s adapter (own process, own narrow auth). Token is a query param
  (`?token=AUDIT_TRAIL_TOKEN`), not a header — `EventSource` cannot set custom headers, so a bearer
  header the way `merchant-api` does it wasn't available. Replays full history on a fresh connect,
  resumes correctly from `Last-Event-ID` on reconnect, then polls Postgres every 500ms for anything new.
  Polling rather than `LISTEN`/`NOTIFY`: every writer already goes through one shared
  `PostgresEventStore.appendFor`, and a plain poll is the simplest thing that stays correctly live for a
  five-minute demo — it also doesn't care which process (MCP server, merchant API, background worker)
  appended the row.
- **The React + Vite + Tailwind viewer** (`web/`) — a separate npm package (`npm run web:dev` from the
  root, or `cd web && npm run dev`), Vite dev server on :5173 proxying `/events` to :4002 so the browser
  never has to deal with CORS. Tailwind v4 via `@tailwindcss/vite`. Dark, dense, monospace-for-ids
  layout per slice-6.md's design guidance ("dense and legible beats sparse and pretty").
  - `EventCard.tsx` — one card per event: timestamp, type, booking id, a per-type one-line synopsis
    (mirrors the prose style of `docs/03-domain-model.md` §6's worked trace), and for the four
    `MoneyFields` event types, the full B1/B4/B3/B2 breakdown (action/gate/bound/authority) plus the
    enforcement badge. `ACTION_REFUSED` gets its own always-prominent red/rose treatment (heavy border,
    glow, ⛔) rather than being just another card — slice-6.md item 6.
  - `EnforcedByBadge.tsx` — the item-3 design decision, "the most important one in the UI." Three tiers,
    each visually escalating (not just re-labeled): `latch_policy` a thin muted outline, `db_constraint`
    a solid blue border, `payment_rail` a heavy emerald border with a glow and a pulsing 3-dot strength
    meter. `AUTHORIZATION_HELD` — not a `MoneyFields` event, so it has no `bound.enforcedBy` to key off —
    gets the same badge anyway (hardcoded `payment_rail`, since that's the only value that event can ever
    carry), because it's where the no-show ceiling first appears in the trail and the worked trace calls
    that out explicitly ("the authorised amount IS the ceiling").
  - `totals.ts` — running totals computed from event **type**, not the raw `action.direction` field.
    `direction` (`'credit' | 'debit'`) is rendered verbatim on each card since it's part of the literal
    recorded fact (and matches `docs/03-domain-model.md` §6's own trace prose exactly, credit/debit and
    all), but summing it blindly across event types isn't safe — `docs/03-domain-model.md` §4's event
    catalogue table is the actual authority for a running total's direction (`DEPOSIT_CAPTURED` in,
    `RETENTION_APPLIED` kept, `REFUND_ISSUED` out, `NO_SHOW_CHARGED` in), so totals key off `event.type`
    instead. Authorisation headroom is tracked per-booking (set on `AUTHORIZATION_HELD`, updated on
    `NO_SHOW_CHARGED`, cleared on `AUTHORIZATION_RELEASED`/`AUTHORIZATION_LAPSED`) and summed across every
    still-open authorisation.
  - `useEventStream.ts` — owns the `EventSource`, dedupes by `eventId` (defensive; the server-side cursor
    fix below makes this a non-issue in practice), surfaces a connecting/live/reconnecting indicator.
- **`.env` / `.env.example`** — new `AUDIT_TRAIL_TOKEN` (root) and `VITE_AUDIT_TRAIL_TOKEN` (`web/`,
  gitignored, must match). `web/.gitignore` updated to ignore `.env` (the Vite template doesn't by
  default).

## The one real bug this slice caught: ordering a global event feed is not free

The first implementation ordered `listAllEvents` by `eventId` (a ULID) on the theory that ULIDs are
lexicographically time-sortable. Live-testing against a real `decline_booking` call — the five-event
`MERCHANT_DECLINED → SLOT_RELEASED → REFUND_ISSUED → AUTHORIZATION_RELEASED → ALTERNATIVES_OFFERED`
transaction — showed the SSE feed delivering them out of causal order. ULIDs encode millisecond
resolution; a single fast transaction appends all five rows within the same millisecond, and a ULID's
sub-millisecond bits are random, not causal. Caught by piping the live SSE output through a small Python
check comparing delivery order against each event's own `sequence` field, not by inspection.

First fix attempt: order by `(occurredAt, bookingId, sequence)` as a compound key, using `sequence`
(guaranteed monotonic per booking) to break timestamp ties. This *also* turned out wrong, for a different
reason: `occurredAt` comes from the `Clock` port, and `background-workers.integration.test.ts`
legitimately advances a `FrozenClock` far into the future (to simulate a no-show's grace period elapsing)
against the *real, shared* dev Postgres database — so a genuine row with `occurredAt: 2026-09-18` already
existed in `events` from a prior test run. Sorting the global feed by `occurredAt` meant that row was
always "last," which poisoned the cursor: any event appended at real wall-clock "now" (chronologically
before September 2026) could never satisfy `occurredAt > cursor.occurredAt`, so the feed would replay
history once and then silently stop delivering anything new. Caught the same way — a curl capture that
stopped growing after the initial replay, traced to the cursor comparison via a throwaway script hitting
`listAllEvents` directly.

**The actual fix:** `events.global_sequence`, a new `bigserial` column — literal row-insertion order,
decoupled from every domain-meaningful field (`occurredAt`, `eventId`, `sequence`) that a test can
legitimately construct to *not* reflect real insertion time. `listAllEvents`/`findGlobalSequence` order
and page by it exclusively now. Simpler code, too — a plain integer `gt()` filter instead of a row-wise
tuple comparison in raw SQL.

**Migration gotcha, hit for real this time.** Generating migration `0008` reproduced exactly the failure
mode dev-log 010 flagged in advance: `drizzle-kit generate`'s `Date.now()`-based `when`
(`1787528461605`) sorted *behind* migration `0007`'s hand-bumped timestamp (`1787556000000`), which would
have made the Postgres migrator silently skip it — no error, "migrations applied" prints anyway. Caught
before running it, specifically because dev-log 010 said to check; hand-bumped to `1787559600000` (one
hour past `0007`, continuing the existing hand-bumped sequence) before migrating. Confirmed the column
landed for real (`select global_sequence, event_id from events order by global_sequence desc limit 5`
returned real data) rather than trusting the "migrations applied" log line alone.

## What was verified, and how

No visual/browser check was possible this session — the Claude-in-Chrome extension was not connected,
and macOS's screen-recording permission isn't granted to this sandboxed shell (`screencapture` failed
with "could not create image from display"). **The UI has not been looked at.** Everything below was
verified functionally, against the real running stack:

1. `npm test` — 119 tests, clean, after the schema migration (unchanged pass count, confirming nothing
   else depends on `events`' column order).
2. `npx tsc --noEmit` clean on both the root project and `web/` (`npm run build` in `web/`, which runs
   `tsc -b && vite build`, including `noUnusedLocals`/`noUnusedParameters`).
3. Drove `npm run demo:ceiling-refusal` (fresh hold → policy ack → deposit → authorisation → confirm →
   ceiling refusal, `FakePaymentRail`) against a live `curl -N` capture of `GET /events` — all 6 events
   arrived, in order, with the exact field shapes the viewer's components read (`action.direction`,
   `bound.enforcedBy`, `refusalCode`, etc.).
4. Declined that same booking via the merchant API — all 11 events across the full happy path +
   ceiling-refusal + failure path streamed live, **in exact `sequence` order (1–11)**, matching
   `docs/03-domain-model.md` §6's worked trace.
5. Ran that booking's captured event stream through the same type-based logic `totals.ts` uses: **net
   customer cost lands on exactly ₹0** after the merchant decline (₹300 deposit − ₹300 refund) — the
   demo's punchline, confirmed on real data rather than assumed from the code.
6. Reconnect: captured the `eventId` of the `ACTION_REFUSED` event mid-trail, opened a fresh `curl`
   with `Last-Event-ID` set to it, and got back exactly sequences 7–11 (the decline path) — not a full
   replay, not a gap. The dedupe in `useEventStream.ts` is defense in depth; the server already resumes
   correctly on its own.

**Before trusting this UI on stage, someone needs to actually open `http://localhost:5173` in a browser**
(with `npm run audit-trail:dev`, `npm run merchant-api:dev`, and `npm run web:dev` all running) and look
at it. The data layer is proven; the rendering has only been reasoned about from the component source,
not observed.

## Decisions made that the docs did not settle

- **Running totals are computed from `event.type`, not `action.direction`.** See `totals.ts`'s note
  above — the two axes aren't the same thing and conflating them would have been wrong specifically for
  `NO_SHOW_CHARGED` (documented as money "in" to the merchant in the event catalogue, but recorded with
  `direction: 'debit'` in the actual event, matching `docs/03-domain-model.md` §6's own trace prose). Both
  are rendered — `direction` verbatim on the card, the catalogue's in/kept/out semantics in the totals bar
  — rather than picking one and hiding the other.
- **`AUTHORIZATION_HELD` gets the `EnforcedByBadge` despite not being a `MoneyFields` event.** Its
  `enforcedBy` is a flat, always-`'payment_rail'` field, not nested under a `bound` object — but it's the
  event where the ceiling is first established, and the worked trace explicitly calls out its enforcement
  strength in prose. Leaving it as plain text would have undersold exactly the claim slice-6.md's item 3
  cares most about.
- **A `bigserial` column over `LISTEN`/`NOTIFY` or a smarter in-memory ordering scheme.** Simplest correct
  fix once the actual failure mode (domain timestamps and ULIDs both legitimately diverge from insertion
  order under real test conditions) was understood; see above.

## Carried forward

- **Visual verification is still owed.** See the callout above — this is the top item for whoever picks
  up next, before this ships in the pitch video.
- **Slice 7** (deployed; a remote agent connects) is next per `prompts/README.md`. The viewer as built is
  local-only (`localhost:5173` proxying to `localhost:4002`) — deployment wiring (reverse proxy, CORS if
  the viewer and SSE server end up on different origins in prod, a real token instead of the shared dev
  one) is Slice 7 or later, not attempted here per slice-6.md's explicit "deployment" out-of-scope line.
- Nothing else from dev-log 010's carry-forward list was touched this slice (the live-network refund
  idempotent-replay flake, etc.) — still open, still out of this slice's scope.
