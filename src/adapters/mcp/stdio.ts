#!/usr/bin/env node
/**
 * MCP over stdio, for local dev / connecting from Claude Code or Claude
 * Desktop directly. docs/02-tech-stack.md §3 — stdio now, Streamable HTTP
 * comes in Slice 7 and will reuse `createServer` unchanged.
 *
 * Wires real Postgres adapters + the system clock always. The payment
 * provider defaults to `FakePaymentProvider` and only switches to the real
 * `RazorpayPaymentProvider` when `PAYMENT_PROVIDER=razorpay` is explicitly
 * set — deliberately not just "whenever Razorpay keys are present in
 * .env", because `mcp-e2e.integration.test.ts` (Slice 1) spawns this exact
 * entrypoint as a subprocess and asserts `confirm_with_deposit` completes
 * synchronously. A real Razorpay capture only completes once a customer
 * finishes Checkout (see dev-logs/006) — nobody is present to do that
 * during an automated test run, so that test would hang and time out if
 * this defaulted to Razorpay whenever keys happen to be configured.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { AppDeps } from '../../app/types.js'
import type { PaymentProvider } from '../../ports/payment-provider.js'
import { SystemClock } from '../clock/system-clock.js'
import { createDbClient } from '../db/client.js'
import { PostgresCatalogRepo } from '../db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../db/postgres-idempotency-store.js'
import { SEED_MERCHANT_ID } from '../db/seed-data.js'
import { FakePaymentProvider } from '../payment/fake-payment-provider.js'
import { RazorpayPaymentProvider } from '../payment/razorpay-payment-provider.js'
import { createServer } from './server.js'

process.loadEnvFile?.('.env')

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set')
}

function buildPaymentProvider(): PaymentProvider {
  if (process.env['PAYMENT_PROVIDER'] !== 'razorpay') {
    return new FakePaymentProvider()
  }
  const keyId = process.env['RAZORPAY_KEY_ID']
  const keySecret = process.env['RAZORPAY_KEY_SECRET']
  if (!keyId || !keySecret) {
    throw new Error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to be set')
  }
  return new RazorpayPaymentProvider({ keyId, keySecret })
}

const { db } = createDbClient(databaseUrl)

const deps: AppDeps = {
  clock: new SystemClock(),
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider: buildPaymentProvider(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  merchantId: process.env['MERCHANT_ID'] ?? SEED_MERCHANT_ID,
}

const server = createServer(deps)
const transport = new StdioServerTransport()
await server.connect(transport)
