import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
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
