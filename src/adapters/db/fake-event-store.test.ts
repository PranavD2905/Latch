import { describe, expect, it } from 'vitest'
import { FrozenClock } from '../clock/frozen-clock.js'
import { createHoldCreatedEvent, createHoldExpiredEvent } from '../../domain/event-factory.js'
import type { BookingSnapshot } from '../../ports/event-store.js'
import { FakeEventStore } from './fake-event-store.js'

const NOW = new Date('2026-08-25T00:00:00+05:30')
const clock = new FrozenClock(NOW)

function heldSnapshot(overrides: Partial<BookingSnapshot> = {}): BookingSnapshot {
  return {
    bookingId: 'bkg_1',
    merchantId: 'mer_1',
    practitionerId: 'prac_1',
    serviceId: 'svc_1',
    startsAt: new Date(NOW.getTime() + 3_600_000),
    status: 'HELD',
    policyVersion: undefined,
    authorizationId: undefined,
    authorizationAmountPaise: undefined,
    authorizationExpiresAt: undefined,
    authorizationLapsedAt: undefined,
    sessionCompleteAuthorizationId: undefined,
    sessionCompleteAuthorizationAmountPaise: undefined,
    sessionCompleteAuthorizationExpiresAt: undefined,
    sessionCompleteAuthorizationLapsedAt: undefined,
    nonAttendanceMarkedAt: undefined,
    noShowEligibleMarkedAt: undefined,
    agentId: 'agent_1',
    holdExpiresAt: new Date(NOW.getTime() + 60_000),
    lastEventSequence: 1,
    ...overrides,
  }
}

describe('FakeEventStore', () => {
  it('append records the event and the projection together, readable back by loadEvents/loadSnapshot', async () => {
    const store = new FakeEventStore()
    const event = createHoldCreatedEvent('bkg_1', 1, clock, { practitionerId: 'prac_1', serviceId: 'svc_1', startsAt: heldSnapshot().startsAt, ttlSeconds: 60 })

    await store.transaction(async (tx) => {
      await tx.append([event], heldSnapshot(), 'mer_1')
    })

    expect(await store.loadEvents('bkg_1')).toEqual([event])
    expect(await store.loadSnapshot('bkg_1')).toEqual(heldSnapshot())
  })

  it('append with no projection records the event but no bookings row — a pure refusal', async () => {
    const store = new FakeEventStore()
    const event = createHoldCreatedEvent('bkg_2', 1, clock, { practitionerId: 'prac_1', serviceId: 'svc_1', startsAt: NOW, ttlSeconds: 60 })
    await store.transaction(async (tx) => {
      await tx.append([event], undefined, 'mer_1')
    })
    expect(await store.loadEvents('bkg_2')).toEqual([event])
    expect(await store.loadSnapshot('bkg_2')).toBeUndefined()
  })

  it('append rejects an empty event list', async () => {
    const store = new FakeEventStore()
    await expect(store.transaction(async (tx) => tx.append([], undefined, 'mer_1'))).rejects.toThrow('append() called with no events')
  })

  it('countLiveHoldsForAgent counts only HELD bookings for that merchant+agent pair', async () => {
    const store = new FakeEventStore()
    await store.transaction(async (tx) => {
      await tx.append([createHoldCreatedEvent('bkg_1', 1, clock, { practitionerId: 'p', serviceId: 's', startsAt: NOW, ttlSeconds: 60 })], heldSnapshot({ bookingId: 'bkg_1' }), 'mer_1')
      await tx.append(
        [createHoldCreatedEvent('bkg_2', 1, clock, { practitionerId: 'p', serviceId: 's', startsAt: NOW, ttlSeconds: 60 })],
        heldSnapshot({ bookingId: 'bkg_2', status: 'CONFIRMED' }),
        'mer_1',
      )
      await tx.append(
        [createHoldCreatedEvent('bkg_3', 1, clock, { practitionerId: 'p', serviceId: 's', startsAt: NOW, ttlSeconds: 60 })],
        heldSnapshot({ bookingId: 'bkg_3', merchantId: 'mer_2' }),
        'mer_2',
      )
    })
    expect(await store.countLiveHoldsForAgent('mer_1', 'agent_1')).toBe(1)
  })

  it('claimHeldBookingsWithExpiredHold returns only HELD bookings past their own holdExpiresAt', async () => {
    const store = new FakeEventStore()
    await store.transaction(async (tx) => {
      await tx.append(
        [createHoldCreatedEvent('bkg_1', 1, clock, { practitionerId: 'p', serviceId: 's', startsAt: NOW, ttlSeconds: 60 })],
        heldSnapshot({ bookingId: 'bkg_1', holdExpiresAt: new Date(NOW.getTime() - 1000) }),
        'mer_1',
      )
      await tx.append(
        [createHoldCreatedEvent('bkg_2', 1, clock, { practitionerId: 'p', serviceId: 's', startsAt: NOW, ttlSeconds: 60 })],
        heldSnapshot({ bookingId: 'bkg_2', holdExpiresAt: new Date(NOW.getTime() + 1_000_000) }),
        'mer_1',
      )
    })
    const claimed = await store.transaction((tx) => tx.claimHeldBookingsWithExpiredHold(NOW, 100))
    expect(claimed.map((b) => b.bookingId)).toEqual(['bkg_1'])
  })

  it('countBookingsCreatedByAgentSince counts a HOLD_CREATED event regardless of the booking\'s current status', async () => {
    const store = new FakeEventStore()
    const bookingId = 'bkg_1'
    await store.transaction(async (tx) => {
      await tx.append([createHoldCreatedEvent(bookingId, 1, clock, { practitionerId: 'p', serviceId: 's', startsAt: NOW, ttlSeconds: 60 })], heldSnapshot(), 'mer_1')
      await tx.append([createHoldExpiredEvent(bookingId, 2, clock, {})], heldSnapshot({ status: 'EXPIRED' }), 'mer_1')
    })
    expect(await store.transaction((tx) => tx.countBookingsCreatedByAgentSince('mer_1', 'agent_1', new Date(NOW.getTime() - 1000)))).toBe(1)
    expect(await store.transaction((tx) => tx.countBookingsCreatedByAgentSince('mer_1', 'agent_1', new Date(NOW.getTime() + 1000)))).toBe(0)
  })

  it('listAllEvents scopes strictly by merchantId and supports afterGlobalSequence paging', async () => {
    const store = new FakeEventStore()
    await store.transaction(async (tx) => {
      await tx.append([createHoldCreatedEvent('bkg_1', 1, clock, { practitionerId: 'p', serviceId: 's', startsAt: NOW, ttlSeconds: 60 })], heldSnapshot({ bookingId: 'bkg_1' }), 'mer_1')
      await tx.append(
        [createHoldCreatedEvent('bkg_2', 1, clock, { practitionerId: 'p', serviceId: 's', startsAt: NOW, ttlSeconds: 60 })],
        heldSnapshot({ bookingId: 'bkg_2', merchantId: 'mer_2' }),
        'mer_2',
      )
    })
    const mer1Events = await store.listAllEvents('mer_1')
    expect(mer1Events).toHaveLength(1)
    expect(mer1Events[0]!.event.bookingId).toBe('bkg_1')

    const paged = await store.listAllEvents('mer_1', mer1Events[0]!.globalSequence)
    expect(paged).toHaveLength(0)
  })
})
