import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify'
import type { Logger } from '../../ports/logger.js'

/**
 * Spread into `Fastify({...})` on every service (`mcp`, `merchant-api`,
 * `audit-trail`, `rest`) to wire in a pre-built `Logger` plus X-Trace-ID
 * correlation. `requestIdHeader` makes Fastify read an inbound `X-Trace-ID`
 * itself; `genReqId` only runs when that header is absent. `requestIdLogLabel`
 * renames the field Fastify's own request logging attaches from its default
 * `reqId` to `traceId`, matching the field name used everywhere else a
 * request-scoped logger is built (`Logger.child({ traceId })`).
 *
 * Cast through `unknown`: `Logger` is deliberately narrower than
 * `FastifyBaseLogger` (no `fatal`/`trace`, no `level` setter) — Pino's actual
 * instance has all of those, this cast just tells Fastify's stricter type
 * that the narrower port reference is safe to hand it.
 */
export function loggingFastifyOptions(logger: Logger): { loggerInstance: FastifyBaseLogger; genReqId: (req: { headers: Record<string, unknown> }) => string; requestIdHeader: string; requestIdLogLabel: string } {
  return {
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-trace-id',
    requestIdLogLabel: 'traceId',
  }
}

/**
 * Echoes the resolved trace id back as `X-Trace-ID` on every normal
 * (non-hijacked) response. A hijacked reply (the MCP routes, the SSE feed)
 * bypasses Fastify's `onSend` pipeline entirely by design, so those routes
 * set the header themselves, directly on `reply.raw`, before writing.
 */
export function echoTraceIdHeader(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-trace-id', request.id)
    return payload
  })
}

/**
 * A safety net, not the primary error path — every route in this codebase
 * that can fail in an expected way already catches its own specific error
 * types and picks its own status code (`decline-booking`'s
 * `BookingNotFoundError`/`BookingNotDeclinableError`, etc.). This only ever
 * fires for what those catches don't cover: a genuine bug, a DB outage, an
 * enriched `PaymentProviderError`/`PaymentRailError` (dev-logs/019) that
 * propagated past `requestDeps()`-scoped handlers unhandled. Logs the full
 * error (`request.log` already carries `traceId` — no need to duplicate it
 * into the log fields) and returns `{ error, traceId, code }` so whoever
 * called can hand the trace id back for support, without ever leaking an
 * internal exception message on a 5xx. A `reply.hijack()`ed route (the MCP
 * transport, the SSE feed) never reaches this either, same as
 * `echoTraceIdHeader` above — those already handle their own errors
 * directly, before or instead of hijacking.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const statusCode = err.statusCode ?? 500
    request.log.error({ err, path: request.url, method: request.method, statusCode }, 'unhandled request error')
    if (statusCode >= 500) {
      void reply.status(statusCode).send({ error: 'internal server error', traceId: request.id })
      return
    }
    // A genuine 4xx from Fastify's own machinery (route/body schema
    // validation, an unparseable body) — safe to surface `err.message`
    // (validation failure text), never internal exception detail.
    void reply.status(statusCode).send({ error: err.message, traceId: request.id, code: err.code })
  })
}
