import type { CatalogRepo, PractitionerRecord, ServiceRecord } from '../../ports/catalog-repo.js'
import { PolicyVersionConflictError } from '../../ports/catalog-repo.js'
import type { Paise } from '../../domain/money.js'
import type { Policy, PolicyInput } from '../../domain/policy.js'

/**
 * `CatalogRepo`'s in-memory test double — same role as `FakePaymentProvider`/
 * `FakePaymentRail` (docs/02-tech-stack.md §13). Merchants, practitioners,
 * and services are seeded directly via the `set*`/constructor helpers below;
 * policies go through `publishPolicy` for real, so a test gets the same
 * "insert a new version, never update" behaviour `PostgresCatalogRepo`
 * actually has, including `PolicyVersionConflictError` on a version clash.
 */
export class FakeCatalogRepo implements CatalogRepo {
  private readonly merchants = new Map<string, { merchantId: string; name: string }>()
  private readonly practitioners = new Map<string, PractitionerRecord>()
  private readonly services = new Map<string, ServiceRecord>()
  private readonly policiesByMerchant = new Map<string, Policy[]>()

  setMerchant(merchant: { merchantId: string; name: string }): void {
    this.merchants.set(merchant.merchantId, merchant)
  }

  setPractitioner(practitioner: PractitionerRecord): void {
    this.practitioners.set(practitioner.practitionerId, practitioner)
  }

  setService(service: ServiceRecord): void {
    this.services.set(service.serviceId, service)
  }

  /** Test setup shortcut — bypasses `publishPolicy`'s version-derivation when a test just wants a specific policy to already be active. */
  seedPolicy(merchantId: string, policy: Policy): void {
    const existing = this.policiesByMerchant.get(merchantId) ?? []
    this.policiesByMerchant.set(merchantId, [...existing, policy])
  }

  async getMerchant(merchantId: string): Promise<{ merchantId: string; name: string } | undefined> {
    return this.merchants.get(merchantId)
  }

  async getPractitioner(practitionerId: string): Promise<PractitionerRecord | undefined> {
    return this.practitioners.get(practitionerId)
  }

  async getService(serviceId: string): Promise<ServiceRecord | undefined> {
    return this.services.get(serviceId)
  }

  async listServices(merchantId: string): Promise<readonly ServiceRecord[]> {
    return [...this.services.values()].filter((s) => s.merchantId === merchantId)
  }

  async updateService(
    merchantId: string,
    serviceId: string,
    patch: { name?: string; durationMinutes?: number; pricePaise?: Paise },
    _updatedAt: Date,
  ): Promise<ServiceRecord | undefined> {
    const existing = this.services.get(serviceId)
    if (!existing || existing.merchantId !== merchantId) return undefined
    const updated: ServiceRecord = { ...existing, ...patch }
    this.services.set(serviceId, updated)
    return updated
  }

  async getActivePolicy(merchantId: string): Promise<Policy | undefined> {
    const versions = this.policiesByMerchant.get(merchantId)
    if (!versions || versions.length === 0) return undefined
    return versions.reduce((latest, p) => (p.policyVersion > latest.policyVersion ? p : latest))
  }

  async getPolicyVersion(merchantId: string, version: number): Promise<Policy | undefined> {
    return this.policiesByMerchant.get(merchantId)?.find((p) => p.policyVersion === version)
  }

  async publishPolicy(merchantId: string, input: PolicyInput, _publishedAt: Date): Promise<Policy> {
    const versions = this.policiesByMerchant.get(merchantId) ?? []
    const nextVersion = versions.length === 0 ? 1 : Math.max(...versions.map((p) => p.policyVersion)) + 1
    if (versions.some((p) => p.policyVersion === nextVersion)) {
      throw new PolicyVersionConflictError(`policy version ${nextVersion} already exists for merchant ${merchantId}`)
    }
    const policy: Policy = { ...input, policyVersion: nextVersion } as Policy
    this.policiesByMerchant.set(merchantId, [...versions, policy])
    return policy
  }
}
