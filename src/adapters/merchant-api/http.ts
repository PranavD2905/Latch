#!/usr/bin/env node
/**
 * The merchant API over HTTP, for local dev and for the merchant-decline
 * demo. Mirrors src/adapters/mcp/stdio.ts's wiring (real Postgres + system
 * clock always; FakePaymentProvider unless PAYMENT_PROVIDER=razorpay is
 * explicit) — see that file's comment for why the Razorpay provider is
 * opt-in rather than automatic.
 */
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { createDbClient } from '../db/client.js'
import { createMerchantApiServer } from './server.js'

process.loadEnvFile?.('.env')

const merchantToken = process.env['MERCHANT_API_TOKEN']
if (!merchantToken) {
  throw new Error('MERCHANT_API_TOKEN is not set — required to authenticate merchant-only calls like decline_booking')
}

const { db } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db)

const app = createMerchantApiServer(deps, { merchantToken })
const port = Number(process.env['MERCHANT_API_PORT'] ?? 4001)
await app.listen({ port, host: '0.0.0.0' })
console.log(`merchant API listening on :${port}`)
