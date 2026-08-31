import type { Paise } from '../domain/money.js'
import type { Policy, PolicyInput } from '../domain/policy.js'
import type { WorkingHours } from '../domain/slots.js'

export interface PractitionerRecord {
  practitionerId: string
  merchantId: string
  name: string
  workingHours: WorkingHours
}

export interface ServiceRecord {
  serviceId: string
  merchantId: string
  name: string
  durationMinutes: number
  pricePaise: Paise
}

/**
 * Outbound port over the reference data — merchant/practitioner/service/policy.
 * Read-only in Slice 1 (policy authoring is a merchant-side, out-of-scope
 * concern here). Kept separate from `EventStore` because this data is not
 * event-sourced — it's plain rows a merchant configures, not a fold.
 */
export interface CatalogRepo {
  /** Migration 0011 — resolves a merchant id to its display name, or `undefined` if unknown. The check every merchant-scoped route (MCP's `/mcp/:merchantId`, `GET /slots?merchant=...`) makes before trusting a caller-supplied merchant id at all — a cheap indexed primary-key lookup, not a guess. */
  getMerchant(merchantId: string): Promise<{ merchantId: string; name: string } | undefined>
  getPractitioner(practitionerId: string): Promise<PractitionerRecord | undefined>
  getService(serviceId: string): Promise<ServiceRecord | undefined>
  /** Every service this merchant offers — the merchant-facing pricing UI's read, not something an agent ever calls (`find_slots` takes a specific `serviceId` already). */
  listServices(merchantId: string): Promise<readonly ServiceRecord[]>
  /**
   * Merchant-only price/name/duration edit — a plain `UPDATE`, not versioned
   * the way `policies` is (see `schema.ts`'s `services.pricePaise` doc
   * comment for why that's safe: the mandate amount is frozen onto each
   * booking at confirm time, so this never retroactively changes what an
   * already-confirmed booking owes). `undefined` if `serviceId` doesn't
   * belong to `merchantId` — same "unknown, not forbidden" treatment
   * `tenant-guard.ts` uses everywhere else.
   */
  updateService(merchantId: string, serviceId: string, patch: { name?: string; durationMinutes?: number; pricePaise?: Paise }, updatedAt: Date): Promise<ServiceRecord | undefined>
  /** The current (highest-version) policy for a merchant — the authority `confirm_with_deposit` checks staleness against. */
  getActivePolicy(merchantId: string): Promise<Policy | undefined>
  /**
   * A specific historical policy version. Slice 5: "a booking made under
   * ladder v4 must be cancelled under ladder v4, even if the merchant has
   * since published v5" (docs/03-domain-model.md §2) — `cancel` and
   * `reschedule` must evaluate the ladder the booking was actually confirmed
   * under, never the merchant's current policy, exactly the discipline
   * `BookingSnapshot.sessionCompleteAuthorizationAmountPaise` already applies
   * to the session-complete mandate (dev-logs/009).
   */
  getPolicyVersion(merchantId: string, version: number): Promise<Policy | undefined>
  /**
   * `set_policy`'s write path (this task). An INSERT, never an UPDATE — see
   * `docs/03-domain-model.md` §2. `version` is not a parameter: the adapter
   * derives it itself as `currentActiveVersion + 1` and relies on the
   * `policies_merchant_version_unique` constraint, not a check-then-insert,
   * to make a concurrent double-publish fail loudly rather than race
   * silently (the same discipline `hold_slot` already applies to
   * `one_live_booking_per_slot` — see `isUniqueViolation`). Throws
   * `PolicyVersionConflictError` when that constraint fires.
   */
  publishPolicy(merchantId: string, input: PolicyInput, publishedAt: Date): Promise<Policy>
}

/**
 * Thrown when two publishes race and both compute the same next version —
 * the `policies_merchant_version_unique` constraint fired, so the loser's
 * insert never happened. Not a `RefusalCode`/`Refusal` (that vocabulary is
 * for agent-facing gates; no agent can ever reach `set_policy`) — this is a
 * merchant-facing conflict, and the correct next step is "reload the current
 * policy and resubmit," not "retry blindly."
 */
export class PolicyVersionConflictError extends Error {}
