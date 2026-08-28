import rateLimit from '@fastify/rate-limit'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { AppDeps } from '../../app/types.js'
import { echoTraceIdHeader, loggingFastifyOptions, registerErrorHandler } from '../observability/fastify-logging.js'
import { mcpRateLimitTriggeredTotal, registerMetricsRoute } from '../observability/metrics.js'
import { createServer } from './server.js'

/**
 * Scalability review follow-up: transport-level DoS protection, distinct
 * from (and layered underneath) `hold_slot`'s own DB-backed request-rate
 * bound (`docs/01-architecture.md` §12). That one is a *business* ceiling —
 * how many bookings-holds one agent may accumulate against one merchant —
 * and correctly needs to be exact and DB-verified because a bypass has real
 * money-adjacent consequences (calendar-lockout abuse). This one exists
 * purely to stop a raw flood of HTTP requests from exhausting the process
 * before any request ever reaches a tool handler: a fresh `McpServer` +
 * `StreamableHTTPServerTransport` is allocated per request by design (see
 * this file's own module doc comment on why), so an unthrottled flood is a
 * real resource-exhaustion path at volume. Approximate and per-process
 * (the default in-memory store, not a shared one) is the right tier of
 * correctness for that job — Redis is a deliberately rejected dependency
 * for this codebase (docs/02-tech-stack.md §15), and a coarse throttle that
 * only has to survive a *single* replica's own flood doesn't need
 * cross-replica exactness the way a real money bound would. With N
 * `latch-mcp` replicas, the effective ceiling is N × `MCP_RATE_LIMIT_MAX`
 * across the fleet, not a hard fleet-wide cap — an accepted tradeoff, not
 * an oversight.
 */
const MCP_RATE_LIMIT_MAX = Number(process.env['MCP_RATE_LIMIT_MAX'] ?? 300)
const MCP_RATE_LIMIT_WINDOW_MS = Number(process.env['MCP_RATE_LIMIT_WINDOW_MS'] ?? 60_000)

function methodNotAllowed(request: FastifyRequest, reply: FastifyReply): void {
  reply.hijack()
  reply.raw.writeHead(405, { 'Content-Type': 'application/json', 'X-Trace-ID': request.id })
  reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }))
}

/**
 * MCP over Streamable HTTP, docs/02-tech-stack.md §3 — the deployed
 * transport. A remote agent reaches this over the public internet, rather
 * than spawning `stdio.ts` as a subprocess on the same machine — that
 * distinction is the whole point of Slice 7 (prompts/slice-7.md: "the
 * transport should embody the claim").
 *
 * Stateless mode (`sessionIdGenerator: undefined`), matching the MCP SDK's
 * own reference pattern for this exact shape of server: every tool handler
 * in `createServer` is a pure function of `deps` (Postgres is the only
 * shared state, already safe for concurrent access), so there is no
 * per-connection session state worth paying a session-management protocol
 * for. A fresh `McpServer` + transport is built per request and torn down
 * when the response closes — cheap, and it means this scales to multiple
 * Railway instances later with no sticky-session requirement.
 *
 * Deliberately unauthenticated — as in, no *agent* credential is required.
 * docs' own thesis (agentic-services-transactability-brief.md, and
 * slice-7.md itself) is that a third-party agent can transact with a
 * merchant with no partnership and no integration deal; gating `/mcp`
 * behind a bearer token an agent would have to obtain first would
 * contradict that directly. That claim is about *agent* identity, though,
 * not *merchant* identity — those are separate questions (docs/01-
 * architecture.md §10, superseded by migration 0011's real multi-tenant
 * support). A remote agent still has to say which merchant it means to
 * transact with, the same way it addresses any other multi-tenant API: the
 * merchant id is a path segment, `/mcp/:merchantId`, public and
 * discoverable — not a secret an agent must be handed — checked only for
 * "does this merchant exist," never "is the caller allowed to see it."
 * `merchant-api` and the audit-trail viewer keep their own narrow,
 * DB-issued tokens; this route is the one meant to be genuinely open. Real
 * money never moves here without Razorpay's own gates (test mode for the
 * buildathon regardless).
 *
 * `/mcp` with no merchant segment is kept as a deprecated alias for
 * whichever merchant `MERCHANT_ID`/`SEED_MERCHANT_ID` resolves to (the same
 * default `buildAppDeps` already used pre-migration-0011) — so a client
 * already configured against the bare path keeps working, but a fresh
 * integration should always address a merchant explicitly.
 */
export async function createMcpHttpServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify(loggingFastifyOptions(deps.logger))
  echoTraceIdHeader(app)
  registerErrorHandler(app)

  // `global: false` — registering it this way means nothing is throttled by
  // default; only routes that opt in via `config: { rateLimit: {...} }`
  // below are. `/healthz` deliberately stays unthrottled (Railway's own
  // health check polls it continuously and must never see a 429).
  //
  // Awaited deliberately: `@fastify/rate-limit` attaches its per-route
  // `config.rateLimit` support via an `onRoute` hook it registers as part
  // of its own async plugin body. Without awaiting here, that hook isn't
  // guaranteed to be attached yet when the `app.post(...)` calls below run,
  // and the routes silently register with no rate limiting at all — no
  // error, no warning, just a limiter that never fires. Caught by actually
  // testing this against a running server, not by reading the docs: the
  // README's own route-level example awaits the registration too, and a
  // from-scratch repro confirmed dropping the `await` reproduces exactly
  // this silent-no-op failure.
  await app.register(rateLimit, { global: false })

  async function handleMcpRequest(request: FastifyRequest, reply: FastifyReply, merchantId: string): Promise<void> {
    const merchant = await deps.catalogRepo.getMerchant(merchantId)
    if (!merchant) {
      reply.hijack()
      reply.raw.writeHead(404, { 'Content-Type': 'application/json', 'X-Trace-ID': request.id })
      reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: `unknown merchant: ${merchantId}` }, id: null }))
      return
    }

    // A fresh `AppDeps` per request, scoped to whichever merchant the path
    // named — cheap (an object spread over the same shared `db`
    // connection pool, `PaymentProvider`, etc.), never a new connection.
    // `logger` is `request.log`, not `deps.logger` directly — Fastify
    // already built it as `deps.logger.child({ traceId: request.id })`
    // (`requestIdLogLabel` in `loggingFastifyOptions`), so every log line an
    // app-layer handler emits for this request carries the same traceId a
    // Fastify access-log line for it would.
    const requestDeps: AppDeps = { ...deps, merchantId, logger: request.log }
    const server = createServer(requestDeps)
    // Omitting sessionIdGenerator (rather than setting it to `undefined`)
    // is what puts the transport in stateless mode — see the SDK's own
    // doc comment on the option. Passing the key explicitly with an
    // `undefined` value doesn't type-check under this repo's
    // `exactOptionalPropertyTypes`.
    const transport = new StreamableHTTPServerTransport({})

    reply.hijack()
    reply.raw.setHeader('X-Trace-ID', request.id)
    reply.raw.on('close', () => {
      transport.close()
      server.close()
    })

    try {
      // `StreamableHTTPServerTransport`'s `onclose`/`onerror`/`onmessage`
      // accessors accept `| undefined` at the setter, one degree looser
      // than `Transport`'s own optional-property declarations — a real
      // mismatch between the SDK's two .d.ts files under
      // `exactOptionalPropertyTypes`, not a logic issue on either side.
      await server.connect(transport as Transport)
      await transport.handleRequest(request.raw, reply.raw, request.body)
    } catch (err) {
      request.log.error({ err, merchantId }, 'error handling MCP request')
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' })
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }))
      }
    }
  }

  const rateLimitConfig = {
    config: {
      rateLimit: {
        max: MCP_RATE_LIMIT_MAX,
        timeWindow: MCP_RATE_LIMIT_WINDOW_MS,
        // Per caller IP — the standard transport-level DoS key. Known
        // weakness, named rather than hidden: callers behind a shared
        // NAT/corporate proxy/agent gateway share one bucket. Acceptable
        // here because the ceiling (300/min by default) is sized for "stop
        // a flood," not "meter one real agent" — a legitimate agent's
        // find_slots/get_policy/hold_slot/confirm_with_deposit sequence for
        // one booking is a handful of calls, nowhere near this.
        // `@fastify/rate-limit` `throw`s whatever this returns as an error
        // object (`index.js`'s own source, not documented in the README's
        // example) — Fastify's error pipeline reads `.statusCode` off a
        // thrown error to pick the HTTP status, so the returned object
        // needs that field explicitly or every rejection serialises
        // correctly (right body, right headers) but reports 500 instead of
        // `context.statusCode` (429, or 403 once banned). Caught by
        // actually testing a rejected request, not by reading the docs.
        errorResponseBuilder: (_request: unknown, context: { statusCode: number }) => {
          mcpRateLimitTriggeredTotal.inc()
          return {
            statusCode: context.statusCode,
            jsonrpc: '2.0',
            error: { code: -32029, message: `rate limit exceeded — max ${MCP_RATE_LIMIT_MAX} requests per ${MCP_RATE_LIMIT_WINDOW_MS / 1000}s per caller` },
            id: null,
          }
        },
      },
    },
  }

  app.post<{ Params: { merchantId: string } }>('/mcp/:merchantId', rateLimitConfig, async (request, reply) => {
    await handleMcpRequest(request, reply, request.params.merchantId)
  })
  app.post('/mcp', rateLimitConfig, async (request, reply) => {
    await handleMcpRequest(request, reply, deps.merchantId)
  })

  // The stateless pattern above never hands out a session id, so a
  // compliant client never has a reason to open the standalone GET stream
  // or send DELETE — matching the MCP SDK's own stateless example server.
  app.get('/mcp/:merchantId', async (request, reply) => methodNotAllowed(request, reply))
  app.delete('/mcp/:merchantId', async (request, reply) => methodNotAllowed(request, reply))
  app.get('/mcp', async (request, reply) => methodNotAllowed(request, reply))
  app.delete('/mcp', async (request, reply) => methodNotAllowed(request, reply))

  app.get('/healthz', async () => ({ ok: true }))
  registerMetricsRoute(app)

  return app
}
