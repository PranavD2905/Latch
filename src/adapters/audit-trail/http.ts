#!/usr/bin/env node
/**
 * The audit-trail SSE server, for local dev and the Slice 6 viewer. Mirrors
 * `src/adapters/merchant-api/http.ts`'s wiring (real Postgres + system clock
 * always; the payment provider/rail are unused by this surface but
 * `buildAppDeps` builds them anyway since `AppDeps` is one shared shape).
 */
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { createDbClient } from '../db/client.js'
import { createAuditTrailServer } from './server.js'

process.loadEnvFile?.('.env')

const viewerToken = process.env['AUDIT_TRAIL_TOKEN']
if (!viewerToken) {
  throw new Error('AUDIT_TRAIL_TOKEN is not set — required so the viewer\'s SSE feed is not wide open')
}

const { db } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db)

const app = createAuditTrailServer(deps, { viewerToken })
const port = Number(process.env['AUDIT_TRAIL_PORT'] ?? 4002)
await app.listen({ port, host: '0.0.0.0' })
console.log(`audit trail SSE server listening on :${port}`)
