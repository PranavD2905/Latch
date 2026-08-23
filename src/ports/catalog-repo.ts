import type { Paise } from '../domain/money.js'
import type { Policy } from '../domain/policy.js'
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
  getPractitioner(practitionerId: string): Promise<PractitionerRecord | undefined>
  getService(serviceId: string): Promise<ServiceRecord | undefined>
  /** The current (highest-version) policy for a merchant — the authority `confirm_with_deposit` checks staleness against. */
  getActivePolicy(merchantId: string): Promise<Policy | undefined>
  /**
   * A specific historical policy version. Slice 5: "a booking made under
   * ladder v4 must be cancelled under ladder v4, even if the merchant has
   * since published v5" (docs/03-domain-model.md §2) — `cancel` and
   * `reschedule` must evaluate the ladder the booking was actually confirmed
   * under, never the merchant's current policy, exactly the discipline
   * `BookingSnapshot.authorizationAmountPaise` already applies to the
   * no-show fee (dev-logs/009).
   */
  getPolicyVersion(merchantId: string, version: number): Promise<Policy | undefined>
}
