import Fastify, { type FastifyInstance } from 'fastify'
import type { AppDeps } from '../../app/types.js'
import type { EventWithGlobalSequence } from '../../ports/event-store.js'
import type { MerchantAuthStore } from '../../ports/merchant-auth.js'
import { echoTraceIdHeader, loggingFastifyOptions } from '../observability/fastify-logging.js'
import { registerMetricsRoute } from '../observability/metrics.js'

export interface AuditTrailServerOptions {
  /**
   * Migration 0011 — replaces the single static `AUDIT_TRAIL_TOKEN` env var
   * with a per-merchant, DB-issued credential (`scope: 'audit_trail'`).
   * Checked as a query param, not a header — the browser's native
   * `EventSource` cannot set custom headers, so a bearer header isn't an
   * option for this route (unchanged from the original design).
   */
  merchantAuthStore: MerchantAuthStore
}

const POLL_INTERVAL_MS = 500

/**
 * One shared poll per merchant, fanned out in-process to every connected
 * viewer for that merchant — not one poll per connection. Before this, N
 * browser tabs watching the same merchant meant N independent
 * `listAllEvents` queries every 500ms, so the query rate scaled with viewer
 * count instead of staying flat; a merchant nobody is watching costs
 * nothing (the interval is created on the first connection and torn down on
 * the last disconnection, not kept running speculatively).
 */
interface MerchantFeed {
  /** This merchant's own polling cursor — independent of any one viewer's cursor (a reconnecting viewer catches up separately, from its own `Last-Event-ID`). */
  cursor: number | undefined
  listeners: Set<(batch: readonly EventWithGlobalSequence[]) => void>
  interval: ReturnType<typeof setInterval>
}

/**
 * Slice 6 — the live audit trail's SSE feed (prompts/slice-6.md,
 * docs/02-tech-stack.md §10). One route, one job: stream every
 * `BookingEvent` for one merchant, oldest first, replaying history on
 * connect and then staying live for new rows.
 *
 * A separate Fastify instance/process from the merchant API and the MCP
 * server, same convention as `merchant-api/server.ts` — this is a read-only
 * surface with its own narrow auth, not a route bolted onto an existing app.
 *
 * Polling rather than `LISTEN`/`NOTIFY`: every writer already goes through
 * `PostgresEventStore.appendFor` inside a transaction, so a plain poll of
 * `listAllEvents(merchantId, afterGlobalSequence)` on a short interval is
 * the simplest thing that is still correctly live, and it doesn't care which
 * process (MCP server, merchant API, background worker) appended the event.
 */
export function createAuditTrailServer(deps: AppDeps, options: AuditTrailServerOptions): FastifyInstance {
  const app = Fastify(loggingFastifyOptions(deps.logger))
  echoTraceIdHeader(app)

  const feeds = new Map<string, MerchantFeed>()

  async function poll(merchantId: string): Promise<void> {
    const feed = feeds.get(merchantId)
    if (!feed || feed.listeners.size === 0) return // nobody watching this merchant right now — skip the query entirely
    const batch = await deps.eventStore.listAllEvents(merchantId, feed.cursor)
    if (batch.length === 0) return
    feed.cursor = batch[batch.length - 1]!.globalSequence
    for (const listener of feed.listeners) listener(batch)
  }

  function getOrCreateFeed(merchantId: string): MerchantFeed {
    const existing = feeds.get(merchantId)
    if (existing) return existing
    const feed: MerchantFeed = {
      cursor: undefined,
      listeners: new Set(),
      interval: setInterval(() => void poll(merchantId), POLL_INTERVAL_MS),
    }
    feeds.set(merchantId, feed)
    return feed
  }

  function releaseFeed(merchantId: string, listener: (batch: readonly EventWithGlobalSequence[]) => void): void {
    const feed = feeds.get(merchantId)
    if (!feed) return
    feed.listeners.delete(listener)
    if (feed.listeners.size === 0) {
      clearInterval(feed.interval)
      feeds.delete(merchantId)
    }
  }

  // Unauthenticated on purpose — Railway's own health check (docs/07-deployment.md)
  // needs to reach this without the viewer token.
  app.get('/healthz', async () => ({ ok: true }))
  registerMetricsRoute(app)

  app.get<{ Querystring: { token?: string } }>('/events', async (request, reply) => {
    const token = request.query.token
    const resolved = token ? await options.merchantAuthStore.verifyToken(token, 'audit_trail') : undefined
    if (!resolved) {
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }
    const merchantId = resolved.merchantId

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Trace-ID': request.id,
    })
    // Node doesn't actually put the status line + headers on the wire at
    // `writeHead()` — by default it waits for the first `write()`/`end()`
    // and piggybacks the header block on that. On a fresh deploy with a
    // genuinely empty `events` table, the initial catch-up below writes zero
    // bytes on connect, so without this the client (curl, `EventSource`,
    // Railway's own proxy) sees no response at all — not slow, not
    // buffered, nothing — until an actual event eventually gets appended.
    // `EventSource.onopen` never fires, so the viewer would sit on
    // "CONNECTING" forever the very first time anyone opens it against a
    // fresh deploy. Verified against the real Railway deployment, not
    // simulated: `curl -N` hung indefinitely against `/events` with an empty
    // table before this fix.
    reply.raw.flushHeaders()

    // `EventSource` sends this automatically on reconnect after a dropped
    // connection — resuming from it (rather than always replaying
    // everything) is what makes the "reconnect after a dropped connection
    // replays correctly" acceptance criterion true without the client
    // having to dedupe. A fresh connect has no header, so `cursor` stays
    // undefined and the catch-up below replays this merchant's full
    // history. The header only carries a bare eventId, so it's resolved to
    // its `globalSequence` once, up front — scoped to this merchant, so a
    // reconnecting viewer can't use `Last-Event-ID` to probe another
    // merchant's event ids.
    const lastEventIdHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader
    let cursor: number | undefined = lastEventId ? await deps.eventStore.findGlobalSequence(merchantId, lastEventId) : undefined

    let closed = false
    request.raw.on('close', () => {
      closed = true
    })

    // Writes only events this connection hasn't already sent — a monotonic
    // cursor check, not a batch-identity check, so it stays correct
    // regardless of whether a given event arrives via this connection's own
    // catch-up query or via the shared per-merchant poll's live broadcast
    // (both can race to deliver the same early rows; whichever arrives
    // first advances `cursor` and the other is silently skipped).
    const deliver = (batch: readonly EventWithGlobalSequence[]): void => {
      for (const { event, globalSequence } of batch) {
        if (closed) return
        if (cursor !== undefined && globalSequence <= cursor) continue
        reply.raw.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`)
        cursor = globalSequence
      }
    }

    // Subscribed before the catch-up query runs, deliberately — otherwise an
    // event appended while the catch-up query is in flight could land in
    // neither: not in the catch-up result (queried before it existed) and
    // not delivered live (subscribed after it was broadcast).
    const feed = getOrCreateFeed(merchantId)
    feed.listeners.add(deliver)

    const initial = await deps.eventStore.listAllEvents(merchantId, cursor)
    deliver(initial)

    request.raw.on('close', () => {
      releaseFeed(merchantId, deliver)
      reply.raw.end()
    })
  })

  return app
}
