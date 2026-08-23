import { desc, eq } from 'drizzle-orm'
import { toPaise } from '../../domain/money.js'
import type { LadderTier } from '../../domain/policy.js'
import type { CatalogRepo, PractitionerRecord, ServiceRecord } from '../../ports/catalog-repo.js'
import type { Db } from './client.js'
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
    return {
      policyVersion: row.version,
      depositAmountPaise: toPaise(row.depositAmountPaise),
      cancellationLadder: row.cancellationLadder as readonly LadderTier[],
      noShowFeePaise: toPaise(row.noShowFeePaise),
      noShowGraceMinutes: row.noShowGraceMinutes,
      mandateCeilingPaise: toPaise(row.mandateCeilingPaise),
      holdTtlSeconds: row.holdTtlSeconds,
      maxConcurrentHoldsPerAgent: row.maxConcurrentHoldsPerAgent,
    }
  }
}
