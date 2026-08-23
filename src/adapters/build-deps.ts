import type { AppDeps } from '../app/types.js'
import type { PaymentProvider } from '../ports/payment-provider.js'
import type { PaymentRail } from '../ports/payment-rail.js'
import { SystemClock } from './clock/system-clock.js'
import type { Db } from './db/client.js'
import { PostgresCatalogRepo } from './db/postgres-catalog-repo.js'
import { PostgresEventStore } from './db/postgres-event-store.js'
import { PostgresIdempotencyStore } from './db/postgres-idempotency-store.js'
import { SEED_MERCHANT_ID } from './db/seed-data.js'
import { FakePaymentProvider } from './payment/fake-payment-provider.js'
import { FakePaymentRail } from './payment/fake-payment-rail.js'
import { ManualCaptureRail } from './payment/manual-capture-rail.js'
import { RazorpayPaymentProvider } from './payment/razorpay-payment-provider.js'
import { ReservePayRail } from './payment/reserve-pay-rail.js'

export function requireDatabaseUrl(): string {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }
  return databaseUrl
}

function usingRazorpay(): boolean {
  return process.env['PAYMENT_PROVIDER'] === 'razorpay'
}

function razorpayCredentials(): { keyId: string; keySecret: string } {
  const keyId = process.env['RAZORPAY_KEY_ID']
  const keySecret = process.env['RAZORPAY_KEY_SECRET']
  if (!keyId || !keySecret) {
    throw new Error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to be set')
  }
  return { keyId, keySecret }
}

function buildPaymentProvider(): PaymentProvider {
  return usingRazorpay() ? new RazorpayPaymentProvider(razorpayCredentials()) : new FakePaymentProvider()
}

/**
 * `PAYMENT_RAIL=reserve_pay` exists only to prove `ReservePayRail` is really
 * wired to the same entrypoints as `ManualCaptureRail` — docs/01-architecture.md
 * Idea 3: "the swap is a module boundary, not a rewrite." It is not a
 * supported runtime mode: `ReservePayRail` throws on first use
 * (dev-logs/005/007).
 */
function buildPaymentRail(): PaymentRail {
  if (!usingRazorpay()) return new FakePaymentRail()
  if (process.env['PAYMENT_RAIL'] === 'reserve_pay') return new ReservePayRail()
  return new ManualCaptureRail(razorpayCredentials())
}

/**
 * Wires the real Postgres adapters + the system clock always, shared by
 * every process entrypoint (`stdio.ts`, `merchant-api/http.ts`, the
 * authorisation-lapse worker). The payment provider/rail default to their
 * fakes and only switch to real Razorpay when `PAYMENT_PROVIDER=razorpay` is
 * explicit — see dev-logs/006 for why this is opt-in rather than automatic
 * whenever keys are present.
 */
export function buildAppDeps(db: Db): AppDeps {
  return {
    clock: new SystemClock(),
    eventStore: new PostgresEventStore(db),
    catalogRepo: new PostgresCatalogRepo(db),
    paymentProvider: buildPaymentProvider(),
    paymentRail: buildPaymentRail(),
    idempotencyStore: new PostgresIdempotencyStore(db),
    merchantId: process.env['MERCHANT_ID'] ?? SEED_MERCHANT_ID,
  }
}
