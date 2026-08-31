# Latch — live audit trail viewer

React + Vite + Tailwind, Slice 6 of the build sequence (`../docs/06-build-sequence.md`,
`../docs/03-domain-model.md` §4/§6). Renders the SSE feed served by
`../src/adapters/audit-trail/` as a live, dense, rupee-traceable list.

## Run it

Needs `../src/adapters/audit-trail/http.ts` running first (`npm run audit-trail:dev` from the repo
root, port 4002 by default). Then, from the repo root:

```bash
npm run web:dev        # or: cd web && npm run dev
```

Opens on `http://localhost:5173`. `vite.config.ts` proxies `/events` to `:4002`, so the browser never
deals with CORS. `VITE_AUDIT_TRAIL_TOKEN` in `.env` (see `.env.example`) must match the root project's
`AUDIT_TRAIL_TOKEN` — `EventSource` can't set custom headers, so the token travels as a query param.

## Layout

- `App.tsx` — top-level shell: connection indicator, totals bar, event list (newest first).
- `useEventStream.ts` — owns the `EventSource`, dedupes by `eventId`.
- `EventCard.tsx` — one event, rendered per its type; money events get the full B1/B4/B3/B2 breakdown,
  `ACTION_REFUSED` gets its own prominent treatment.
- `EnforcedByBadge.tsx` — the three-tier `bound.enforced_by` visual hierarchy (`latch_policy` <
  `db_constraint` < `payment_rail`) — the single most important design decision in this viewer.
- `totals.ts` — running totals (net customer cost, net merchant retention, authorisation headroom),
  computed from event *type* per `docs/03-domain-model.md` §4's catalogue, not from the raw
  `action.direction` field (see `dev-logs/011` for why those two aren't the same axis).
