import type { FastifyInstance } from 'fastify'
import { findSlots, UnknownPractitionerError, UnknownServiceError } from '../../app/find-slots.js'
import type { AppDeps } from '../../app/types.js'

/**
 * dev-logs/014, item 4. `docs/01-architecture.md` §1's "Why the domain core
 * is isolated" claims "the same domain could be exposed over UCP, A2A, or
 * plain REST by writing another inbound adapter... the architecture is the
 * argument" — this is that argument made checkable rather than asserted.
 * `GET /slots` calls the exact same `findSlots` app-layer function
 * (`src/app/find-slots.ts`) the MCP `find_slots` tool calls
 * (`src/adapters/mcp/server.ts`) — same command handler, same domain core
 * underneath it, zero changes to `src/domain/` or `src/app/` to add this
 * file. If this route and the MCP tool ever disagreed about a slot, that
 * would be a bug in `findSlots` itself, not two implementations drifting
 * apart — there is only one implementation.
 *
 * A plain function that registers routes onto whatever `FastifyInstance` is
 * handed to it, rather than its own `createXServer()` — `createRestServer`
 * below uses it for a genuinely standalone adapter (proving it needs no
 * merchant-api-specific wiring at all), and `src/adapters/merchant-api/server.ts`
 * mounts the identical function onto its own already-public, already-deployed
 * Fastify instance for real reachability without provisioning a fourth
 * Railway service (docs/07-deployment.md's three-service topology) — see
 * dev-logs/014 for that deployment-shape reasoning. Either way it is the
 * same module, the same route, the same handler.
 */
export function registerSlotsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Querystring: { practitionerId?: string; serviceId?: string; days?: string } }>(
    '/slots',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['practitionerId', 'serviceId'],
          properties: {
            practitionerId: { type: 'string', minLength: 1 },
            serviceId: { type: 'string', minLength: 1 },
            days: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { practitionerId, serviceId, days } = request.query
      const parsedDays = days === undefined ? undefined : Number(days)
      if (parsedDays !== undefined && (!Number.isFinite(parsedDays) || parsedDays <= 0)) {
        return reply.code(400).send({ error: 'days must be a positive number' })
      }

      try {
        // The exact same call `src/adapters/mcp/server.ts`'s find_slots tool
        // makes — see the module comment above.
        const result = await findSlots({ practitionerId: practitionerId!, serviceId: serviceId!, days: parsedDays }, deps)
        return await reply.code(200).send(result)
      } catch (err) {
        if (err instanceof UnknownPractitionerError || err instanceof UnknownServiceError) {
          return reply.code(404).send({ error: err.message })
        }
        throw err
      }
    },
  )
}
