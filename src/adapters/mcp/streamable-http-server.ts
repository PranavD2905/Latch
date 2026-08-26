import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { AppDeps } from '../../app/types.js'
import { createServer } from './server.js'

function methodNotAllowed(reply: import('fastify').FastifyReply): void {
  reply.hijack()
  reply.raw.writeHead(405, { 'Content-Type': 'application/json' })
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
export function createMcpHttpServer(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  async function handleMcpRequest(request: FastifyRequest, reply: FastifyReply, merchantId: string): Promise<void> {
    const merchant = await deps.catalogRepo.getMerchant(merchantId)
    if (!merchant) {
      reply.hijack()
      reply.raw.writeHead(404, { 'Content-Type': 'application/json' })
      reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: `unknown merchant: ${merchantId}` }, id: null }))
      return
    }

    // A fresh `AppDeps` per request, scoped to whichever merchant the path
    // named — cheap (an object spread over the same shared `db`
    // connection pool, `PaymentProvider`, etc.), never a new connection.
    const requestDeps: AppDeps = { ...deps, merchantId }
    const server = createServer(requestDeps)
    // Omitting sessionIdGenerator (rather than setting it to `undefined`)
    // is what puts the transport in stateless mode — see the SDK's own
    // doc comment on the option. Passing the key explicitly with an
    // `undefined` value doesn't type-check under this repo's
    // `exactOptionalPropertyTypes`.
    const transport = new StreamableHTTPServerTransport({})

    reply.hijack()
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
      console.error('error handling MCP request:', err)
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' })
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }))
      }
    }
  }

  app.post<{ Params: { merchantId: string } }>('/mcp/:merchantId', async (request, reply) => {
    await handleMcpRequest(request, reply, request.params.merchantId)
  })
  app.post('/mcp', async (request, reply) => {
    await handleMcpRequest(request, reply, deps.merchantId)
  })

  // The stateless pattern above never hands out a session id, so a
  // compliant client never has a reason to open the standalone GET stream
  // or send DELETE — matching the MCP SDK's own stateless example server.
  app.get('/mcp/:merchantId', async (_request, reply) => methodNotAllowed(reply))
  app.delete('/mcp/:merchantId', async (_request, reply) => methodNotAllowed(reply))
  app.get('/mcp', async (_request, reply) => methodNotAllowed(reply))
  app.delete('/mcp', async (_request, reply) => methodNotAllowed(reply))

  app.get('/healthz', async () => ({ ok: true }))

  return app
}
