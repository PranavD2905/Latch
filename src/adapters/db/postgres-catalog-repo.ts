import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { toPaise } from '../../domain/money.js'
import type { LadderTier, Policy, PolicyInput } from '../../domain/policy.js'
import { PolicyVersionConflictError, type CatalogRepo, type PractitionerRecord, type ServiceRecord } from '../../ports/catalog-repo.js'
import type { Db } from './client.js'
import { isUniqueViolation } from './postgres-errors.js'
import { policies, practitioners, services } from './schema.js'

export class PostgresCatalogRepo implements CatalogRepo {
  constructor(private readonly db: Db) {}

  async getPractitioner(practitionerId: string): Promise<PractitionerRecord | undefined> {
    const rows = await this.db.select().from(practitioners).where(eq(practitioners.practitionerId, practitionerId)).limit(1)
    const row = rows[0]
    if (!row) return undefined
    return {
      practitionerId: row.practitionerId,
      merchantId: row.merchantId,
      name: row.name,
      workingHours: row.workingHours as PractitionerRecord['workingHours'],
    }
  }

  async getService(serviceId: string): Promise<ServiceRecord | undefined> {
    const rows = await this.db.select().from(services).where(eq(services.serviceId, serviceId)).limit(1)
    const row = rows[0]
    if (!row) return undefined
    return {
      serviceId: row.serviceId,
      merchantId: row.merchantId,
      name: row.name,
      durationMinutes: row.durationMinutes,
      pricePaise: toPaise(row.pricePaise),
    }
  }

  async getActivePolicy(merchantId: string) {
    const rows = await this.db
      .select()
      .from(policies)
      .where(eq(policies.merchantId, merchantId))
      .orderBy(desc(policies.version))
      .limit(1)
    const row = rows[0]
    if (!row) return undefined
    return rowToPolicy(row)
  }

  async getPolicyVersion(merchantId: string, version: number) {
    const rows = await this.db
      .select()
      .from(policies)
      .where(and(eq(policies.merchantId, merchantId), eq(policies.version, version)))
      .limit(1)
    const row = rows[0]
    if (!row) return undefined
    return rowToPolicy(row)
  }

  /**
   * `set_policy`'s write path. No lock, no read-check-then-write — deliberately
   * the same shape as `hold_slot`'s race against `one_live_booking_per_slot`
   * (docs/01-architecture.md §4): compute the version from the latest read,
   * attempt the INSERT, and let `policies_merchant_version_unique` be the
   * thing that actually decides a race, because a unique index can't be
   * raced and an `if` can. `getActivePolicy` itself never needs `FOR UPDATE`
   * here — the constraint is the correctness mechanism, not this read.
   */
  async publishPolicy(merchantId: string, input: PolicyInput, publishedAt: Date): Promise<Policy> {
    const current = await this.getActivePolicy(merchantId)
    const newVersion = (current?.policyVersion ?? 0) + 1

    try {
      const rows = await this.db
        .insert(policies)
        .values({
          policyId: `pol_${ulid()}`,
          merchantId,
          version: newVersion,
          depositType: 'fixed', // the only deposit type this domain models — see Policy's own doc comment
          depositAmountPaise: input.depositAmountPaise,
          cancellationLadder: input.cancellationLadder,
          noShowFeePaise: input.noShowFeePaise,
          noShowGraceMinutes: input.noShowGraceMinutes,
          holdTtlSeconds: input.holdTtlSeconds,
          maxConcurrentHoldsPerAgent: input.maxConcurrentHoldsPerAgent,
          holdRateLimitPerMinute: input.holdRateLimitPerMinute,
          createdAt: publishedAt,
        })
        .returning()
      return rowToPolicy(rows[0]!)
    } catch (err) {
      if (isUniqueViolation(err, 'policies_merchant_version_unique')) {
        throw new PolicyVersionConflictError(
          `policy version ${newVersion} for merchant ${merchantId} was just published by a concurrent request — reload the current policy and try again`,
        )
      }
      throw err
    }
  }
}

function rowToPolicy(row: typeof policies.$inferSelect) {
  return {
    policyVersion: row.version,
    depositAmountPaise: toPaise(row.depositAmountPaise),
    cancellationLadder: row.cancellationLadder as readonly LadderTier[],
    noShowFeePaise: toPaise(row.noShowFeePaise),
    noShowGraceMinutes: row.noShowGraceMinutes,
    holdTtlSeconds: row.holdTtlSeconds,
    maxConcurrentHoldsPerAgent: row.maxConcurrentHoldsPerAgent,
    holdRateLimitPerMinute: row.holdRateLimitPerMinute,
  }
}
