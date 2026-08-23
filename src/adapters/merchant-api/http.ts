#!/usr/bin/env node
/**
 * The merchant API over HTTP, for local dev and for the merchant-decline
 * demo. Mirrors src/adapters/mcp/stdio.ts's wiring (real Postgres + system
 * clock always; FakePaymentProvider unless PAYMENT_PROVIDER=razorpay is
 * explicit) — see that file's comment for why the Razorpay provider is
 * opt-in rather than automatic.
 */
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
import { createMerchantApiServer } from './server.js'

process.loadEnvFile?.('.env')

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set')
}

const merchantToken = process.env['MERCHANT_API_TOKEN']
if (!merchantToken) {
  throw new Error('MERCHANT_API_TOKEN is not set — required to authenticate merchant-only calls like decline_booking')
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

const app = createMerchantApiServer(deps, { merchantToken })
const port = Number(process.env['MERCHANT_API_PORT'] ?? 4001)
await app.listen({ port, host: '0.0.0.0' })
console.log(`merchant API listening on :${port}`)
