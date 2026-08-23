import Fastify, { type FastifyInstance } from 'fastify'
import { BookingNotDeclinableError, BookingNotFoundError, NoDepositFoundError, declineBooking } from '../../app/decline-booking.js'
import type { AppDeps } from '../../app/types.js'

export interface MerchantApiOptions {
  /** docs/02-tech-stack.md §12: "One merchant, one static merchant token." No auth framework — a plain equality check. */
  merchantToken: string
}

/**
 * The merchant-only inbound adapter, docs/01-architecture.md §2's "Merchant
 * API" box — a separate surface from the MCP server. This is what makes "no
 * agent can invoke decline_booking" structural rather than a policy an agent
 * could be trusted to respect: an agent only ever sees the MCP tool list
 * (src/adapters/mcp/server.ts), which has no decline route and never will —
 * this Fastify instance is a wholly separate process/port with its own auth.
 *
 * Scoped to exactly what Slice 3 needs — one route. `mark_no_show` and
 * `set_policy` (also named in the architecture diagram) are later slices'
 * work; this file is not the place to stub them ahead of time.
 */
export function createMerchantApiServer(deps: AppDeps, options: MerchantApiOptions): FastifyInstance {
  const app = Fastify({ logger: false })

  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    if (token !== options.merchantToken) {
      await reply.code(401).send({ error: 'unauthorized' })
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
        const result = await declineBooking({ bookingId, reason, idempotencyKey }, deps)
        return await reply.code(200).send(result)
      } catch (err) {
        if (err instanceof BookingNotFoundError) return reply.code(404).send({ error: err.message })
        if (err instanceof BookingNotDeclinableError) return reply.code(409).send({ error: err.message })
        if (err instanceof NoDepositFoundError) return reply.code(422).send({ error: err.message })
        throw err
      }
    },
  )

  return app
}
