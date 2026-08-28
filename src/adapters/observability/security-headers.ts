import helmet from '@fastify/helmet'
import type { FastifyInstance } from 'fastify'

/**
 * dev-logs/024. `@fastify/helmet` on all four servers — `X-Content-Type-
 * Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`,
 * etc. Genuinely harmless to add everywhere: `mcp`/`merchant-api`/`rest` only
 * ever return JSON, so a browser never renders a page *from* those origins
 * for a CSP or frame-ancestors policy to have anything to say about — the
 * headers are inert there, not actively useful, but free.
 *
 * `audit-trail` is the one server that actually serves an HTML page (the
 * viewer SPA) — `contentSecurityPolicy` is deliberately left off there,
 * rather than shipped with a default or a guessed-at `connect-src`. The
 * viewer makes one real cross-origin fetch in production (`web/src/
 * policyApi.ts`'s calls to `VITE_MERCHANT_API_URL`, dev-logs/015's own
 * documented reason merchant-api runs `@fastify/cors`) — that origin is
 * baked into the frontend bundle at Vite build time, not known to this
 * backend process at runtime, so this server has no correct value to put in
 * `connect-src` without adding a second, parallel env var that would have to
 * be kept in sync with the frontend build's own `VITE_MERCHANT_API_URL` by
 * hand. Shipping a CSP with a guessed-at or wildcard `connect-src` would be
 * security theatre; shipping every *other* Helmet header (frame-ancestors
 * via `X-Frame-Options`, MIME-sniffing protection, etc.) without the one
 * directive this deployment can't correctly express is the honest middle
 * ground.
 */
/**
 * Not awaited, matching `echoTraceIdHeader`/`registerErrorHandler`'s own
 * style in this file's sibling module — unlike `@fastify/rate-limit`
 * (`streamable-http-server.ts`'s own comment on why *that* one genuinely
 * needs awaiting: a per-route hook that must attach before subsequent route
 * registrations run in the same tick), Helmet only adds request/response
 * hooks with nothing else in this codebase depending on same-tick timing —
 * Fastify's own plugin system guarantees it's fully loaded before
 * `.listen()`/`.ready()` resolves regardless.
 */
export function registerSecurityHeaders(app: FastifyInstance, options?: { contentSecurityPolicy?: boolean }): void {
  void app.register(helmet, { contentSecurityPolicy: options?.contentSecurityPolicy ?? true })
}
