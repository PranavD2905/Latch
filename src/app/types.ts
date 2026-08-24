import type { CatalogRepo } from '../ports/catalog-repo.js'
import type { Clock } from '../ports/clock.js'
import type { EventStore } from '../ports/event-store.js'
import type { IdempotencyStore } from '../ports/idempotency-store.js'
import type { PaymentProvider } from '../ports/payment-provider.js'
import type { PaymentRail } from '../ports/payment-rail.js'

/**
 * Everything a command handler needs, injected. This is the seam the
 * hexagonal architecture is for: handlers here depend only on ports
 * (interfaces), never on Drizzle, MCP, or the Razorpay SDK directly. The
 * inbound adapter (MCP server) constructs one of these with real Postgres
 * adapters; tests construct one with fakes/in-memory adapters.
 *
 * `merchantId` is here rather than threaded through every command because
 * this is deliberately not multi-tenant (docs/01-architecture.md §10).
 */
export interface AppDeps {
  clock: Clock
  eventStore: EventStore
  catalogRepo: CatalogRepo
  paymentProvider: PaymentProvider
  /** Slice 4: the no-show authorisation leg (dev-logs/005) — deliberately a separate port from `paymentProvider`. */
  paymentRail: PaymentRail
  idempotencyStore: IdempotencyStore
  merchantId: string
  /**
   * Overrides every handler's default `IdempotencyStore.claim` timeout —
   * dev-logs/013. Undefined in production (each handler picks its own
   * sensible default); tests set a short value to force the
   * `IDEMPOTENT_REPLAY` path deterministically instead of waiting out a
   * multi-minute production ceiling.
   */
  idempotencyClaimTimeoutMs?: number
}
