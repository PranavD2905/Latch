import { describe, expect, it } from 'vitest'
import { toPaise } from '../../domain/money.js'
import { FakeCatalogRepo } from './fake-catalog-repo.js'

const NOW = new Date('2026-08-25T00:00:00+05:30')

function draft() {
  return {
    depositAmountPaise: toPaise(30000),
    cancellationLadder: [],
    holdTtlSeconds: 60,
    maxConcurrentHoldsPerAgent: 3,
    holdRateLimitPerMinute: 10,
  }
}

describe('FakeCatalogRepo', () => {
  it('getService/getPractitioner/getMerchant return undefined for unknown ids', async () => {
    const repo = new FakeCatalogRepo()
    expect(await repo.getService('nope')).toBeUndefined()
    expect(await repo.getPractitioner('nope')).toBeUndefined()
    expect(await repo.getMerchant('nope')).toBeUndefined()
  })

  it('publishPolicy derives version 1 for the first publish, then increments', async () => {
    const repo = new FakeCatalogRepo()
    const v1 = await repo.publishPolicy('mer_1', draft(), NOW)
    expect(v1.policyVersion).toBe(1)
    const v2 = await repo.publishPolicy('mer_1', draft(), NOW)
    expect(v2.policyVersion).toBe(2)
    expect(await repo.getActivePolicy('mer_1')).toEqual(v2)
  })

  it('getPolicyVersion returns a specific historical version even after a newer one publishes', async () => {
    const repo = new FakeCatalogRepo()
    const v1 = await repo.publishPolicy('mer_1', draft(), NOW)
    await repo.publishPolicy('mer_1', draft(), NOW)
    expect(await repo.getPolicyVersion('mer_1', 1)).toEqual(v1)
  })

  it('updateService returns undefined for a service that belongs to a different merchant', async () => {
    const repo = new FakeCatalogRepo()
    repo.setService({ serviceId: 'svc_1', merchantId: 'mer_1', name: 'Consult', durationMinutes: 30, pricePaise: toPaise(80000) })
    expect(await repo.updateService('mer_2', 'svc_1', { pricePaise: toPaise(90000) }, NOW)).toBeUndefined()
    const updated = await repo.updateService('mer_1', 'svc_1', { pricePaise: toPaise(90000) }, NOW)
    expect(updated?.pricePaise).toBe(90000)
  })

  it('seedPolicy lets a test install an already-active policy directly, bypassing version derivation', async () => {
    const repo = new FakeCatalogRepo()
    repo.seedPolicy('mer_1', { ...draft(), policyVersion: 7 })
    expect((await repo.getActivePolicy('mer_1'))?.policyVersion).toBe(7)
  })
})
