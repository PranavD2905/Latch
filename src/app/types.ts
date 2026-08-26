import type { CircuitBreaker } from './circuit-breaker.js'
import type { CatalogRepo } from '../ports/catalog-repo.js'
import type { Clock } from '../ports/clock.js'
import type { EventStore } from '../ports/event-store.js'
import type { IdempotencyStore } from '../ports/idempotency-store.js'
import type { PaymentProvider } from '../ports/payment-provider.js'
import type { PaymentRail } from '../ports/payment-rail.js'
import type { WebhookDeadLetterStore } from '../ports/webhook-dead-letter-store.js'

/**
 * Everything a command handler needs, injected. This is the seam the
 * hexagonal architecture is for: handlers here depend only on ports
 * (interfaces), never on Drizzle, MCP, or the Razorpay SDK directly. The
 * inbound adapter (MCP server) constructs one of these with real Postgres
 * adapters; tests construct one with fakes/in-memory adapters.
 *
 * `merchantId` is here rather than threaded through every command mostly for
 * historical reasons, not a live architectural constraint: migration 0011
 * (docs/01-architecture.md §10) made real multi-tenancy possible without
 * moving it, since `merchantId` was already the last argument on every
 * catalog/event-store call this field's callers make.
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
  /**
   * Guards the reconciliation worker's own outbound Razorpay calls
   * (`reconciliation.ts`'s `detectKnownReferenceMismatches`) — see
   * `circuit-breaker.ts`. One instance per process, built in `build-deps.ts`
   * from the same `clock` above so tests can drive it with a `FrozenClock`
   * exactly like every other timing-sensitive thing in this codebase.
   */
  reconciliationCircuitBreaker: CircuitBreaker
  /** Where a persistently-failing `POST /webhooks/razorpay` delivery gets recorded once it's failed enough times in a row that more Razorpay redeliveries alone won't fix it — see `app/webhook-dead-letter.ts`. */
  webhookDeadLetterStore: WebhookDeadLetterStore
}
