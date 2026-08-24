import Fastify, { type FastifyInstance } from 'fastify'
import type { AppDeps } from '../../app/types.js'

export interface AuditTrailServerOptions {
  /**
   * docs/02-tech-stack.md §12 / prompts/slice-6.md: "auth beyond a simple
   * token" is explicitly out of scope. Same shape as `MERCHANT_API_TOKEN`
   * (src/adapters/merchant-api/server.ts) but checked as a query param, not
   * a header — the browser's native `EventSource` cannot set custom headers,
   * so a bearer header isn't an option for this route.
   */
  viewerToken: string
}

const POLL_INTERVAL_MS = 500

/**
 * Slice 6 — the live audit trail's SSE feed (prompts/slice-6.md,
 * docs/02-tech-stack.md §10). One route, one job: stream every
 * `BookingEvent` across every booking, oldest first, replaying history on
 * connect and then polling for new rows.
 *
 * A separate Fastify instance/process from the merchant API and the MCP
 * server, same convention as `merchant-api/server.ts` — this is a read-only
 * surface with its own narrow auth, not a route bolted onto an existing app.
 *
 * Polling rather than `LISTEN`/`NOTIFY`: every writer already goes through
 * `PostgresEventStore.appendFor` inside a transaction, so a plain poll of
 * `listAllEvents(afterGlobalSequence)` on a short interval is the simplest
 * thing that is still correctly live for a five-minute demo, and it doesn't
 * care which process (MCP server, merchant API, background worker) appended
 * the event.
 */
export function createAuditTrailServer(deps: AppDeps, options: AuditTrailServerOptions): FastifyInstance {
  const app = Fastify({ logger: false })

  // Unauthenticated on purpose — Railway's own health check (docs/07-deployment.md)
  // needs to reach this without the viewer token.
  app.get('/healthz', async () => ({ ok: true }))

  app.get<{ Querystring: { token?: string } }>('/events', async (request, reply) => {
    if (request.query.token !== options.viewerToken) {
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // `EventSource` sends this automatically on reconnect after a dropped
    // connection — resuming from it (rather than always replaying
    // everything) is what makes the "reconnect after a dropped connection
    // replays correctly" acceptance criterion true without the client
    // having to dedupe. A fresh connect has no header, so `cursor` stays
    // undefined and `listAllEvents` replays the full history, per
    // slice-6.md item 1. The header only carries a bare eventId, so it's
    // resolved to its `globalSequence` once, up front.
    const lastEventIdHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader
    let cursor: number | undefined = lastEventId ? await deps.eventStore.findGlobalSequence(lastEventId) : undefined

    let closed = false
    request.raw.on('close', () => {
      closed = true
    })

    const sendBatch = async (): Promise<void> => {
      const batch = await deps.eventStore.listAllEvents(cursor)
      for (const { event, globalSequence } of batch) {
        if (closed) return
        reply.raw.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`)
        cursor = globalSequence
      }
    }

    await sendBatch()

    const interval = setInterval(() => {
      void sendBatch()
    }, POLL_INTERVAL_MS)

    request.raw.on('close', () => {
      clearInterval(interval)
      reply.raw.end()
    })
  })

  return app
}
