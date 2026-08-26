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
  app.get<{ Querystring: { merchant?: string; practitionerId?: string; serviceId?: string; days?: string } }>(
    '/slots',
    {
      schema: {
        querystring: {
          type: 'object',
          // Migration 0011: `merchant` is required — this route is
          // unauthenticated (dev-logs/014, item 4: public and read-only,
          // same posture as MCP's find_slots), so with more than one
          // merchant now able to exist, there is no other way for the
          // caller to say whose calendar it's asking about. It is a public
          // identifier, not a secret — the same role `/mcp/:merchantId`'s
          // path segment plays for the MCP surface.
          required: ['merchant', 'practitionerId', 'serviceId'],
          properties: {
            merchant: { type: 'string', minLength: 1 },
            practitionerId: { type: 'string', minLength: 1 },
            serviceId: { type: 'string', minLength: 1 },
            days: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { merchant, practitionerId, serviceId, days } = request.query
      const parsedDays = days === undefined ? undefined : Number(days)
      if (parsedDays !== undefined && (!Number.isFinite(parsedDays) || parsedDays <= 0)) {
        return reply.code(400).send({ error: 'days must be a positive number' })
      }

      const merchantRecord = await deps.catalogRepo.getMerchant(merchant!)
      if (!merchantRecord) {
        return reply.code(404).send({ error: `unknown merchant: ${merchant}` })
      }

      try {
        // The exact same call `src/adapters/mcp/server.ts`'s find_slots tool
        // makes — see the module comment above. `merchantId` is this
        // request's own, resolved just above, not whatever `deps` happened
        // to be built with at process boot.
        const result = await findSlots({ practitionerId: practitionerId!, serviceId: serviceId!, days: parsedDays }, { ...deps, merchantId: merchantRecord.merchantId })
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
