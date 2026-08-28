import Razorpay from 'razorpay'
import { CircuitBreaker } from '../app/circuit-breaker.js'
import type { AppDeps } from '../app/types.js'
import type { Logger } from '../ports/logger.js'
import type { MerchantAuthStore } from '../ports/merchant-auth.js'
import type { PaymentProvider } from '../ports/payment-provider.js'
import type { PaymentRail } from '../ports/payment-rail.js'
import { SystemClock } from './clock/system-clock.js'
import type { Db } from './db/client.js'
import { PostgresCatalogRepo } from './db/postgres-catalog-repo.js'
import { PostgresEventStore } from './db/postgres-event-store.js'
import { PostgresIdempotencyStore } from './db/postgres-idempotency-store.js'
import { PostgresMerchantAuthStore } from './db/postgres-merchant-auth.js'
import { PostgresWebhookDeadLetterStore } from './db/postgres-webhook-dead-letter-store.js'
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
/**
 * Migration 0011. Deliberately not a field on `AppDeps`: command handlers
 * (`src/app/*.ts`) never authenticate anything — they trust `deps.merchantId`
 * because the inbound HTTP layer already resolved it before building that
 * request's `AppDeps`. This store is that resolution step's own dependency,
 * used only from `merchant-api/server.ts`, `audit-trail/server.ts`, and the
 * onboarding scripts (`seed.ts`, `create-merchant.ts`) — never threaded any
 * further in.
 */
export function buildMerchantAuthStore(db: Db): MerchantAuthStore {
  return new PostgresMerchantAuthStore(db)
}

/**
 * `logger` is required, not defaulted, so every entrypoint has to say which
 * service it is (`createLogger('latch-mcp')`, `createLogger('latch-worker-
 * reconciliation')`, ...) — the same "explicit over inferred" discipline
 * `cancel`'s required `cause` field follows, applied here because a missing
 * `service` field would make a shared log sink unreadable, not because it's
 * mechanically required by anything.
 */
export function buildAppDeps(db: Db, logger: Logger): AppDeps {
  const clock = new SystemClock()
  return {
    clock,
    logger,
    eventStore: new PostgresEventStore(db),
    catalogRepo: new PostgresCatalogRepo(db),
    paymentProvider: buildPaymentProvider(),
    paymentRail: buildPaymentRail(),
    idempotencyStore: new PostgresIdempotencyStore(db),
    merchantId: process.env['MERCHANT_ID'] ?? SEED_MERCHANT_ID,
    // dev-logs/016. One breaker per process (`buildAppDeps` itself is only
    // ever called once per entrypoint — see the file-level callers, all
    // top-level `const deps = buildAppDeps(db)`), shared across every
    // merchant a given process serves. 3 consecutive failures / 2 minute
    // cooldown: tight enough that a genuinely down Razorpay stops getting
    // hit within the same 60s tick it started failing in, loose enough that
    // this never trips on the kind of one-off blip a single retry would
    // have absorbed anyway.
    reconciliationCircuitBreaker: new CircuitBreaker({ name: 'razorpay-reconciliation', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
    // dev-logs/020 — separate instance, separate failure domain (see
    // AppDeps.paymentCircuitBreaker's own doc comment). Same tuning as
    // reconciliation's: 3 consecutive genuine provider failures, 2 minute
    // cooldown before one half-open probe.
    paymentCircuitBreaker: new CircuitBreaker({ name: 'razorpay-payments', clock, failureThreshold: 3, cooldownMs: 2 * 60_000 }),
    webhookDeadLetterStore: new PostgresWebhookDeadLetterStore(db),
  }
}

/**
 * dev-logs/014, item 2: `RAZORPAY_WEBHOOK_SECRET` — separate from
 * `RAZORPAY_KEY_ID`/`_SECRET` because it's issued by a different action
 * (registering the webhook URL, in the Dashboard or via the Webhooks API,
 * not generating API keys). Undefined disables the webhook route rather than
 * crashing `merchant-api` on boot — see `MerchantApiOptions.webhook`'s own
 * comment. The `Razorpay` client here is used only to fetch an order's
 * `notes.bookingId` (`src/adapters/webhook/razorpay-webhook.ts`) — a
 * read-only lookup, never a payment/order-creating call, so building one
 * independent of `PAYMENT_PROVIDER=razorpay` is safe even if this service
 * happens to run with the fake provider in some other environment.
 */
export function buildWebhookOptions(): { secret: string; razorpay: Razorpay } | undefined {
  const secret = process.env['RAZORPAY_WEBHOOK_SECRET']
  const keyId = process.env['RAZORPAY_KEY_ID']
  const keySecret = process.env['RAZORPAY_KEY_SECRET']
  if (!secret || !keyId || !keySecret) return undefined
  return { secret, razorpay: new Razorpay({ key_id: keyId, key_secret: keySecret }) }
}
