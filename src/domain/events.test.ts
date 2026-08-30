import { describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { createDepositCapturedEvent, createHoldCreatedEvent, createMerchantDeclinedEvent } from './event-factory.js'
import type { DepositCapturedEvent } from './events.js'
import { toPaise } from './money.js'

const clock = new FrozenClock(new Date('2026-08-27T09:04:02+05:30'))

describe('event construction', () => {
  it('builds a non-money event from just its own fields', () => {
    const event = createHoldCreatedEvent('bkg_01', 1, clock, {
      practitionerId: 'dr_rao',
      serviceId: 'svc_derm_consult',
      startsAt: new Date('2026-08-27T16:00:00+05:30'),
      ttlSeconds: 600,
    })
    expect(event.type).toBe('HOLD_CREATED')
    expect(event.bookingId).toBe('bkg_01')
    expect(event.occurredAt).toEqual(clock.now())
    expect(event.eventId).toMatch(/^[0-9A-Z]{26}$/) // ULID shape
  })

  it('builds a money event when all four fields are supplied', () => {
    const event: DepositCapturedEvent = createDepositCapturedEvent('bkg_01', 3, clock, {
      action: { direction: 'credit', amountPaise: toPaise(30000), instrument: 'upi' },
      gate: { cleared: ['live_hold', 'policy_acked'], evidence: { holdId: 'hold_1' } },
      bound: { ceilingPaise: toPaise(30000), enforcedBy: 'latch_policy', headroomAfterPaise: toPaise(0) },
      authority: { policyVersion: 4, razorpayPaymentId: 'pay_NkT8s2' },
    })
    expect(event.action.amountPaise).toBe(30000)
    expect(event.bound.enforcedBy).toBe('latch_policy')
  })

  it('cannot construct a money event missing `bound` — a raw object literal', () => {
    // This is Idea 2 made concrete: a DepositCapturedEvent without `bound` must not
    // typecheck. If this ever compiles cleanly, the four-field guarantee has silently broken.
    // @ts-expect-error — `bound` is required on every MoneyFields event and is missing here
    const broken: DepositCapturedEvent = {
      eventId: 'evt_x',
      bookingId: 'bkg_01',
      occurredAt: clock.now(),
      sequence: 1,
      type: 'DEPOSIT_CAPTURED',
      action: { direction: 'credit', amountPaise: toPaise(30000), instrument: 'upi' },
      gate: { cleared: [], evidence: {} },
      authority: { policyVersion: 4 },
    }
    void broken
  })

  it('cannot construct a money event via the factory missing `authority`', () => {
    // Same guarantee, exercised through the constructor real command handlers will actually call.
    // @ts-expect-error — `authority` is missing from the fields argument
    createDepositCapturedEvent('bkg_01', 3, clock, {
      action: { direction: 'credit', amountPaise: toPaise(30000), instrument: 'upi' },
      gate: { cleared: [], evidence: {} },
      bound: { ceilingPaise: toPaise(30000), enforcedBy: 'latch_policy', headroomAfterPaise: toPaise(0) },
    })
  })

  // docs/03-domain-model.md §3 Rule 2 / slice-3.md: "cause is a required
  // field... make omission impossible at the type level." MerchantDeclinedEvent
  // has no default and no optional `cause` — the only value the type allows
  // is the literal 'MERCHANT', and it cannot be left out.
  it('cannot construct MERCHANT_DECLINED via the factory without `cause`', () => {
    // @ts-expect-error — `cause` is missing from the fields argument
    createMerchantDeclinedEvent('bkg_01', 4, clock, { reason: 'practitioner_unavailable' })
  })

  it('cannot construct MERCHANT_DECLINED with cause set to anything but MERCHANT', () => {
    // @ts-expect-error — 'CUSTOMER' is not assignable to the literal type 'MERCHANT'
    createMerchantDeclinedEvent('bkg_01', 4, clock, { reason: 'x', cause: 'CUSTOMER' })
  })
})
