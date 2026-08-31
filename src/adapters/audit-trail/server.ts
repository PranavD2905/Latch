import formBody from '@fastify/formbody'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppDeps } from '../../app/types.js'
import type { BookingSnapshot, EventWithGlobalSequence } from '../../ports/event-store.js'
import type { MerchantAuthStore } from '../../ports/merchant-auth.js'
import { executePaymentCall } from '../../app/payment-circuit-breaker.js'
import { checkAllPendingLegs } from '../../app/pending-payment-status.js'
import { PaymentDeclinedError } from '../../ports/payment-provider.js'
import { loadEnv } from '../config.js'
import { echoTraceIdHeader, loggingFastifyOptions, registerErrorHandler } from '../observability/fastify-logging.js'
import { registerMetricsRoute } from '../observability/metrics.js'
import { registerSecurityHeaders } from '../observability/security-headers.js'
import { renderPayNotFoundPage, renderPayPage, type PayPageLeg } from './pay-page.js'

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

/**
 * Same test `confirm-with-deposit.ts`'s own gate transaction uses to decide
 * whether a hold is still live (`status === 'HELD' && holdExpiresAt > now`)
 * — reused here because `pendingPaymentLegs` alone isn't a tight enough
 * check for the pay routes. `hold-expiry-worker.ts` clears that field when
 * it reclaims an expired booking, but only on its next tick; between the
 * moment a hold actually lapses (by the server clock) and that tick, the
 * booking's `status` is still `HELD` in the DB even though the reservation
 * is no longer live. Comparing `holdExpiresAt` directly against `now`,
 * instead of trusting the worker to have already run, closes that window —
 * this route takes no row lock (unlike the gate transaction), so it can't
 * make the check atomic, only narrow it to the same instant a real customer
 * would actually be looking at the page.
 */
function holdIsLive(snapshot: BookingSnapshot, now: Date): boolean {
  return snapshot.status === 'HELD' && snapshot.holdExpiresAt !== undefined && snapshot.holdExpiresAt.getTime() > now.getTime()
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
  registerErrorHandler(app)
  // contentSecurityPolicy: false — see security-headers.ts's own doc comment.
  // This is the one server that actually serves an HTML page (the viewer
  // SPA), and it makes one real, legitimate cross-origin fetch in production
  // (to VITE_MERCHANT_API_URL, baked into the frontend bundle at build time —
  // dev-logs/015) whose origin this backend process has no correct way to
  // know at runtime.
  registerSecurityHeaders(app, { contentSecurityPolicy: false })
  // Only the deposit leg's UPI-collect form (below) POSTs to this server, as a
  // plain `application/x-www-form-urlencoded` submit — no client JS needed.
  void app.register(formBody)

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

  // Payment-link feature (dev-logs entry for this slice; rebuilt in the
  // follow-up to cover every applicable leg on one page) — the page a human
  // actually pays from. Unauthenticated, same posture as `/`: a bookingId is
  // an unguessable ULID, the same "possession of the link is the capability"
  // model every Checkout-style payment link uses. Deliberately narrow in
  // what it can leak: it resolves *one* booking's own applicable legs by id
  // — no policy internals, no other bookings, no merchant token — and 404s
  // for anything else (unknown booking, or a booking with nothing left in
  // `pendingPaymentLegs`). Served here rather than from `merchant-api` because this is the one server
  // with Helmet's CSP already off (see `registerSecurityHeaders` call
  // above) — Checkout.js is a cross-origin script load a default CSP would
  // block, and merchant-api's contract (JSON only, Bearer-token gated) isn't
  // worth reshaping for one HTML route.
  app.get<{ Params: { bookingId: string }; Querystring: { error?: string } }>('/pay/:bookingId', async (request, reply) => {
    // Razorpay Checkout's netbanking/UPI flows hand off to the bank in a
    // popup and then post the result back through `window.opener`. Helmet's
    // default `Cross-Origin-Opener-Policy: same-origin` severs exactly that
    // reference, so the popup opens, cannot navigate, and sits on
    // `about:blank` forever — the payment stalls at Razorpay `status=created`
    // with no error, because nothing failed; the handoff just never
    // completed. Card payments are unaffected (no popup), which is why this
    // survived until someone paid by netbanking.
    //
    // Scoped to this one route rather than the whole server: the viewer SPA
    // opens no popups and keeps the stricter default. `unsafe-none` is
    // Helmet's own opt-out value, and CORP is widened for the same handoff.
    void reply.header('Cross-Origin-Opener-Policy', 'unsafe-none')
    void reply.header('Cross-Origin-Resource-Policy', 'cross-origin')

    const { bookingId } = request.params
    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    const legs = snapshot?.pendingPaymentLegs
    if (!snapshot || !legs || legs.length === 0 || !holdIsLive(snapshot, deps.clock.now())) {
      await reply.code(404).type('text/html').send(renderPayNotFoundPage())
      return
    }

    // Live per-leg status, same primitive `get_booking` uses
    // (`pending-payment-status.ts`) — the trail only records a leg as
    // captured/authorised once every applicable leg is done, so this page
    // has to ask Razorpay directly to know which legs are actually already
    // paid and render them as done rather than a re-clickable button.
    const statuses = await checkAllPendingLegs(deps, legs, bookingId, deps.clock.now())
    const payPageLegs: PayPageLeg[] = legs.map((leg) => ({
      leg: leg.leg,
      label: leg.label,
      amountPaise: leg.amountPaise,
      orderId: leg.orderId,
      done: statuses?.find((s) => s.leg === leg.leg)?.done ?? false,
    }))

    await reply.type('text/html').send(renderPayPage({ bookingId, legs: payPageLegs, keyId: loadEnv().RAZORPAY_KEY_ID, ...(request.query.error ? { notice: request.query.error } : {}) }))
  })

  // The UPI-collect submit for either S2S-capable leg (`pay-page.ts`'s form,
  // `UPI_S2S_LEGS` branch) — deposit via `paymentProvider`, session-complete
  // authorisation via `paymentRail`, same route either way since both are
  // "submit a VPA against this leg's already-created order." S2S — the VPA
  // goes to Razorpay from *this* server, not the browser. Never trusts the
  // amount from the client (same reasoning as the GET route's own comment):
  // the order this posts against is re-resolved from `pendingPaymentLegs`,
  // not from anything the form itself carries beyond the VPA.
  app.post<{ Params: { bookingId: string; leg: string }; Body: { vpa?: string } }>('/pay/:bookingId/:leg', async (request, reply) => {
    const { bookingId, leg: legName } = request.params
    const vpa = (request.body?.vpa ?? '').trim()

    const back = async (error: string): Promise<void> => {
      await reply.redirect(`/pay/${encodeURIComponent(bookingId)}?error=${encodeURIComponent(error)}`, 303)
    }

    if (legName !== 'deposit' && legName !== 'session_complete_authorization') {
      await reply.code(400).send({ error: 'this leg does not support direct UPI payment' })
      return
    }
    if (!/^[\w.-]+@[\w.-]+$/.test(vpa)) {
      await back('That UPI ID does not look valid — try again.')
      return
    }

    const snapshot = await deps.eventStore.loadSnapshot(bookingId)
    const leg = snapshot?.pendingPaymentLegs?.find((l) => l.leg === legName)
    // Not just "does this leg exist" — a lapsed hold's slot has already gone
    // back to inventory (hold-expiry-worker.ts), so paying now would take
    // real money for a booking that no longer holds anything. `renderPayNotFoundPage`
    // rather than a `back()` notice deliberately: there is nothing to retry.
    if (!snapshot || !leg || !holdIsLive(snapshot, deps.clock.now())) {
      await reply.code(404).type('text/html').send(renderPayNotFoundPage())
      return
    }

    const order = { orderId: leg.orderId, amountPaise: leg.amountPaise }
    try {
      const result =
        legName === 'deposit'
          ? await executePaymentCall(deps.paymentCircuitBreaker, () => deps.paymentProvider.payDepositViaUpiCollect(order, vpa, bookingId))
          : await executePaymentCall(deps.paymentCircuitBreaker, () => deps.paymentRail.authorizeViaUpiCollect(order, vpa, bookingId, deps.clock.now()))
      if (!result) {
        await back('Still confirming with your bank — reload in a few seconds to check.')
        return
      }
    } catch (err) {
      if (err instanceof PaymentDeclinedError) {
        await back('That payment was declined. Try again with a different UPI ID.')
        return
      }
      await back('Something went wrong reaching the payment provider. Try again.')
      return
    }

    await reply.redirect(`/pay/${encodeURIComponent(bookingId)}`, 303)
  })

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
