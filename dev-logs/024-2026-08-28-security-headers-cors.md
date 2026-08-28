# Dev Log 024 — security headers and configurable CORS

**Date:** 28 August 2026
**Phase:** Second of the four lower-priority items (config module → **security headers** → load testing →
tracing).
**Status:** Built and tested. `npm test`: 226/226 passing (no new tests — this is response-header
behaviour, verified live below, not something a unit test adds much over an actual HTTP round trip for).
`npx tsc --noEmit` clean. Verified live against all four servers: Helmet's headers appear correctly on
every one, `merchant-api` carries a real CSP while `audit-trail` correctly omits it, and
`CORS_ALLOWED_ORIGINS` genuinely restricts which origins get reflected back (confirmed both the allowed
and the rejected case).

---

## `@fastify/helmet` on all four servers — but not the same on all four

`registerSecurityHeaders(app, options?)` (`src/adapters/observability/security-headers.ts`) wraps
`@fastify/helmet`. `mcp`/`merchant-api`/`rest` get it with the default `contentSecurityPolicy: true` —
genuinely harmless there: those three only ever return JSON, so a browser never renders a *page* from
those origins for a CSP to have anything to say about. The other headers Helmet adds
(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`, etc.) are
free, real defense-in-depth regardless.

**`audit-trail` is the one server that actually serves an HTML page** — the viewer SPA — and it's the one
place a naive default CSP would have been a real risk, not a formality. The viewer makes one genuine
cross-origin fetch in production: `web/src/policyApi.ts`'s calls to `VITE_MERCHANT_API_URL`
(dev-logs/015's own documented reason `merchant-api` runs `@fastify/cors` at all — the viewer and the
merchant API are two different Railway services). That origin is baked into the frontend bundle at Vite
*build* time; this backend process has no correct value for it at runtime without adding a second,
parallel env var that would have to be kept hand-in-sync with the frontend build's own
`VITE_MERCHANT_API_URL` forever. Rather than guess (a wildcard `connect-src` is close to no CSP at all)
or risk silently breaking the policy editor with an unverifiable directive, `audit-trail` gets
`contentSecurityPolicy: false` explicitly, keeping every other Helmet header. Named as a deliberate,
scoped trade-off — the honest middle ground — not a silent gap.

## `CORS_ALLOWED_ORIGINS` — configurable, defaulting to unchanged behaviour

The spec's ask was "ensure CORS origin is configurable via env rather than hardcoded." `merchant-api/
server.ts`'s existing `origin: true` (reflect the caller's own Origin — dev-logs/015's own reasoning: CORS
only governs which origins JavaScript may *read* a response, real authorization is still the Bearer-token
hook) already isn't hardcoded to one fixed string, but it also wasn't operator-configurable. Unset,
`CORS_ALLOWED_ORIGINS` keeps that exact default. Set (comma-separated), it restricts the plugin's
`origin` option to that explicit list instead — verified live both ways: an allowed origin gets
`Access-Control-Allow-Origin` reflected back, a disallowed one gets no CORS header on the response at all.

## What this didn't touch

No new routes, no change to what any route actually does or who's authorized to call it — this phase is
entirely response headers and one already-existing plugin's configuration surface. `security-headers.ts`
mirrors `fastify-logging.ts`'s own sibling-helper style deliberately (not awaited — Helmet has no per-route
hook-timing hazard the way `@fastify/rate-limit` does, per that plugin's own documented reason for needing
`await`, so there's nothing here forcing every `create*Server` function to become `async`).
