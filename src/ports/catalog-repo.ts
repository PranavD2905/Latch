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
}
