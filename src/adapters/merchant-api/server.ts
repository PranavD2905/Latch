import cors from '@fastify/cors'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type Razorpay from 'razorpay'
import { BookingNotDeclinableError, BookingNotFoundError, NoAuthorizationFoundError, NoDepositFoundError, declineBooking } from '../../app/decline-booking.js'
import { getPolicy, NoActivePolicyError } from '../../app/get-policy.js'
import { BookingNotMarkableError, BookingNotFoundError as MarkBookingNotFoundError, markNoShow } from '../../app/mark-no-show.js'
import { setPolicy, type SetPolicyCommand } from '../../app/set-policy.js'
import type { AppDeps } from '../../app/types.js'
import { recordWebhookFailure } from '../../app/webhook-dead-letter.js'
import { PolicyValidationError } from '../../domain/policy-validation.js'
import { PolicyVersionConflictError } from '../../ports/catalog-repo.js'
import type { MerchantAuthStore } from '../../ports/merchant-auth.js'
import { verifyRazorpayWebhookSignature } from '../payment/razorpay-shared.js'
import { registerSlotsRoute } from '../rest/slots.js'
import { handleRazorpayWebhookPayload, type RazorpayWebhookPayload } from '../webhook/razorpay-webhook.js'

type MerchantScopedRequest = FastifyRequest & { rawBody?: Buffer; merchantId?: string }

export interface MerchantApiOptions {
  /**
   * Migration 0011 — real multi-tenant auth, replacing docs/02-tech-stack.md
   * §12's original "one merchant, one static merchant token" call. Every
   * route below except the three public ones (`/healthz`, `/slots`,
   * `/webhooks/razorpay`) resolves `request.merchantId` from whichever
   * merchant's credential the caller presented — the same running process
   * now serves every merchant, and the bearer token is what says which one a
   * given request is for.
   */
  merchantAuthStore: MerchantAuthStore
  /**
   * dev-logs/014, item 2. Undefined disables `POST /webhooks/razorpay`
   * (returns 503) rather than crashing this whole service on boot — a
   * webhook secret is a real external-registration step (see the route's own
   * comment), and every other route here should keep working without it,
   * exactly the same "opt-in, don't crash the process over an optional
   * capability" discipline `buildPaymentProvider()`/`buildPaymentRail()`
   * already use for `PAYMENT_PROVIDER=razorpay`.
   */
  webhook?: { secret: string; razorpay: Razorpay }
}

/** Query-string-stripped exact/prefix match — `request.url` includes the query string, `/healthz`'s check never needed to care before this file had a route that does. */
function isPublicRoute(url: string): boolean {
  const path = url.split('?')[0]
  return path === '/healthz' || path === '/slots' || path === '/webhooks/razorpay'
}

/**
 * The merchant-only inbound adapter, docs/01-architecture.md §2's "Merchant
 * API" box — a separate surface from the MCP server. This is what makes "no
 * agent can invoke decline_booking" structural rather than a policy an agent
 * could be trusted to respect: an agent only ever sees the MCP tool list
 * (src/adapters/mcp/server.ts), which has no decline route and never will —
 * this Fastify instance is a wholly separate process/port with its own auth.
 *
 * `set_policy` (also named in the architecture diagram) lives here too —
 * `GET`/`POST /policy`, same bearer-token gate as decline/mark-no-show below.
 * Originally cut (`04-features-and-limitations.md` §3, item 1) and reinstated
 * once the schedule allowed it — see dev-logs/015. Also hosts two routes
 * that are not merchant-authenticated at all, each with its
 * own narrower gate instead of the Bearer token: `GET /slots` (dev-logs/014,
 * item 4 — public and read-only, the same posture as MCP's `find_slots`) and
 * `POST /webhooks/razorpay` (dev-logs/014, item 2 — gated by an HMAC
 * signature, not a bearer token, because the caller is Razorpay's own
 * servers, not a merchant operator). Mounting both here rather than
 * provisioning dedicated services keeps the deployed topology at the three
 * Railway services docs/07-deployment.md already describes.
 */
export function createMerchantApiServer(deps: AppDeps, options: MerchantApiOptions): FastifyInstance {
  const app = Fastify({ logger: false })

  // Captures the raw request body alongside the parsed JSON — signature
  // verification (below) must run against the exact bytes Razorpay signed,
  // not a re-serialised `JSON.stringify(request.body)`, which is not
  // guaranteed byte-identical (key order, whitespace). Every other route's
  // `request.body` is unaffected — this parser still returns the same parsed
  // object they already relied on, just with the raw buffer attached too.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body: Buffer, done) => {
    ;(request as FastifyRequest & { rawBody?: Buffer }).rawBody = body
    if (body.length === 0) {
      done(null, {})
      return
    }
    try {
      done(null, JSON.parse(body.toString('utf8')))
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  // dev-logs/015: the merchant policy editor (web viewer) calls /policy
  // directly from the browser, and in production the viewer and this API are
  // two different Railway services (docs/07-deployment.md) — genuinely
  // cross-origin, unlike the SSE feed's same-origin design. CORS only
  // governs which origins JavaScript is allowed to *read* a response; actual
  // authorization is still the Bearer-token hook below, so reflecting the
  // caller's own Origin here doesn't loosen who can act, only who can see
  // the result of an already-gated call.
  app.register(cors, { origin: true, methods: ['GET', 'POST'] })

  // Unauthenticated on purpose — Railway's own health check (docs/07-deployment.md)
  // needs to reach this without a merchant token.
  app.get('/healthz', async () => ({ ok: true }))

  // dev-logs/014, item 4 — see registerSlotsRoute's own doc comment for why
  // this is the identical function/route the standalone REST adapter uses.
  registerSlotsRoute(app, deps)

  app.addHook('onRequest', async (request, reply) => {
    if (isPublicRoute(request.url)) return
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const resolved = token ? await options.merchantAuthStore.verifyToken(token, 'merchant_api') : undefined
    if (!resolved) {
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }
    ;(request as MerchantScopedRequest).merchantId = resolved.merchantId
  })

  /** Every merchant-only route below calls this instead of closing over the shared `deps` — `merchantId` is the caller's own, resolved by the `onRequest` hook above, not a fixed process-wide default. */
  function requestDeps(request: FastifyRequest): AppDeps {
    const merchantId = (request as MerchantScopedRequest).merchantId
    if (!merchantId) {
      // Unreachable in practice — the onRequest hook above 401s first for
      // every non-public route — but typed this way rather than asserted
      // past, so a route registered after the hook by mistake fails loudly
      // instead of silently running as whatever `deps.merchantId` defaults to.
      throw new Error('requestDeps() called without an authenticated merchant on the request')
    }
    return { ...deps, merchantId }
  }

  // dev-logs/014, item 2. Gated by HMAC signature (verified below), not the
  // Bearer token above — Razorpay's own servers are the caller, and they
  // cannot present a merchant token. Security-critical: an endpoint that
  // appends trail events on request without verifying who sent them is a
  // real attack surface in a money system, worse than the gap it closes, if
  // built carelessly (dev-logs/014's own framing of this risk).
  app.post('/webhooks/razorpay', async (request, reply) => {
    if (!options.webhook) {
      return reply.code(503).send({ error: 'webhook not configured — RAZORPAY_WEBHOOK_SECRET is not set' })
    }

    const signatureHeader = request.headers['x-razorpay-signature']
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody
    if (typeof signatureHeader !== 'string' || !rawBody || !verifyRazorpayWebhookSignature(rawBody, signatureHeader, options.webhook.secret)) {
      return reply.code(400).send({ error: 'invalid or missing X-Razorpay-Signature' })
    }

    const payload = request.body as RazorpayWebhookPayload
    const entityId =
      payload.payload?.payment?.entity?.id ?? `${payload.event}:${payload.created_at ?? Date.now()}` // best-effort fallback for an event shape this handler doesn't otherwise read
    const idempotencyKey = `${payload.event}:${entityId}`

    // Same claim/put/release pattern as every money-moving command handler
    // (src/ports/idempotency-store.ts, dev-logs/013) — keyed on Razorpay's
    // own event identity so a redelivered webhook (Razorpay retries on
    // anything but a 2xx) is a safe replay, not a repeated append.
    const claim = await deps.idempotencyStore.claim<{ handled: boolean }>('razorpay_webhook', idempotencyKey, { timeoutMs: 10_000 })
    if (claim.kind === 'completed') {
      return reply.code(200).send({ ok: true, replayed: true })
    }
    if (claim.kind === 'timed_out') {
      // A sibling delivery is still being processed — ack with a retry-later
      // status rather than doing the work twice; Razorpay will redeliver.
      return reply.code(202).send({ ok: true, pending: true })
    }

    try {
      const result = await handleRazorpayWebhookPayload(payload, deps, options.webhook.razorpay)
      await deps.idempotencyStore.put('razorpay_webhook', idempotencyKey, { handled: result.handled })
      return await reply.code(200).send({ ok: true, ...result })
    } catch (err) {
      await deps.idempotencyStore.release('razorpay_webhook', idempotencyKey)

      // dev-logs/016. A delivery that keeps failing the same way is not a
      // shape Razorpay's own retry schedule can fix by itself — past
      // `WEBHOOK_MAX_ATTEMPTS`, ack it (200) so Razorpay stops redelivering
      // and record it as dead-lettered instead of hammering forever; under
      // that budget, still 500 so the existing safe-replay retry keeps
      // working the problem exactly as it already did before this session.
      const { deadLettered } = await recordWebhookFailure(idempotencyKey, { event: payload.event, entityId, payload, error: err }, deps)
      if (deadLettered) {
        return reply.code(200).send({ ok: true, deadLettered: true })
      }
      throw err
    }
  })

  app.post<{ Params: { bookingId: string }; Body: { reason: string; idempotencyKey: string } }>(
    '/bookings/:bookingId/decline',
    {
      // docs/02-tech-stack.md §4: "Routes declare a schema; Fastify validates
      // and serialises against it" — a first-class route property, not
      // something to remember. A malformed request never reaches
      // declineBooking with an `undefined` masquerading as a `string`.
      schema: {
        params: { type: 'object', required: ['bookingId'], properties: { bookingId: { type: 'string', minLength: 1 } } },
        body: {
          type: 'object',
          required: ['reason', 'idempotencyKey'],
          properties: { reason: { type: 'string', minLength: 1 }, idempotencyKey: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { bookingId } = request.params
      const { reason, idempotencyKey } = request.body

      try {
        const result = await declineBooking({ bookingId, reason, idempotencyKey }, requestDeps(request))
        return await reply.code(200).send(result)
      } catch (err) {
        if (err instanceof BookingNotFoundError) return reply.code(404).send({ error: err.message })
        if (err instanceof BookingNotDeclinableError) return reply.code(409).send({ error: err.message })
        if (err instanceof NoDepositFoundError) return reply.code(422).send({ error: err.message })
        if (err instanceof NoAuthorizationFoundError) return reply.code(422).send({ error: err.message })
        throw err
      }
    },
  )

  // Slice 4: the second of charge_no_show's two independent facts
  // (docs/03-domain-model.md §3 Rule 3) — merchant-only, same auth hook as
  // decline above, and equally absent from the MCP tool list.
  app.post<{ Params: { bookingId: string }; Body: { idempotencyKey: string } }>(
    '/bookings/:bookingId/mark-no-show',
    {
      schema: {
        params: { type: 'object', required: ['bookingId'], properties: { bookingId: { type: 'string', minLength: 1 } } },
        body: { type: 'object', required: ['idempotencyKey'], properties: { idempotencyKey: { type: 'string', minLength: 1 } } },
      },
    },
    async (request, reply) => {
      const { bookingId } = request.params
      const { idempotencyKey } = request.body

      try {
        const result = await markNoShow({ bookingId, idempotencyKey }, requestDeps(request))
        return await reply.code(200).send(result)
      } catch (err) {
        if (err instanceof MarkBookingNotFoundError) return reply.code(404).send({ error: err.message })
        if (err instanceof BookingNotMarkableError) return reply.code(409).send({ error: err.message })
        throw err
      }
    },
  )

  // dev-logs/015: the policy editor's read side — same bearer-token gate as
  // every other merchant-only route here, not a public read like GET /slots.
  // Nothing an agent needs; get_policy (MCP) already covers the agent-facing
  // read and is untouched by this task.
  app.get('/policy', async (request, reply) => {
    try {
      const result = await getPolicy(requestDeps(request))
      return await reply.code(200).send(result)
    } catch (err) {
      if (err instanceof NoActivePolicyError) return reply.code(404).send({ error: err.message })
      throw err
    }
  })

  // `set_policy` — dev-logs/015. An INSERT of a new version, never an UPDATE
  // (`src/app/set-policy.ts`'s own doc comment); the version itself is never
  // read from the body — `SetPolicyCommand` has no such field, and the
  // server derives it inside `CatalogRepo.publishPolicy`. Fastify's schema
  // here only checks shape (right fields, right JSON types); every actual
  // money-rule check — ladder ordering, monotonic retention, the floor tier,
  // positive amounts, sane bounds — is `validatePolicyInput`'s job, so it
  // runs identically no matter what calls this route.
  app.post<{ Body: SetPolicyCommand }>(
    '/policy',
    {
      schema: {
        body: {
          type: 'object',
          required: ['depositAmountPaise', 'cancellationLadder', 'noShowFeePaise', 'noShowGraceMinutes', 'holdTtlSeconds', 'maxConcurrentHoldsPerAgent', 'holdRateLimitPerMinute'],
          properties: {
            depositAmountPaise: { type: 'number' },
            cancellationLadder: {
              type: 'array',
              items: {
                type: 'object',
                required: ['hoursBefore', 'retainPct'],
                properties: { hoursBefore: { type: 'number' }, retainPct: { type: 'number' } },
              },
            },
            noShowFeePaise: { type: 'number' },
            noShowGraceMinutes: { type: 'number' },
            holdTtlSeconds: { type: 'number' },
            maxConcurrentHoldsPerAgent: { type: 'number' },
            holdRateLimitPerMinute: { type: 'number' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await setPolicy(request.body, requestDeps(request))
        return await reply.code(200).send(result)
      } catch (err) {
        if (err instanceof PolicyValidationError) return reply.code(422).send({ error: err.message, code: err.code })
        if (err instanceof PolicyVersionConflictError) return reply.code(409).send({ error: err.message })
        throw err
      }
    },
  )

  return app
}
