import { describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import {
  createBookingConfirmedEvent,
  createDepositCapturedEvent,
  createHoldCreatedEvent,
  createMandateRegisteredEvent,
  createMandateRevokedEvent,
  createMerchantDeclinedEvent,
  createNoShowChargedEvent,
  createNoShowEligibleEvent,
  createPolicyAcknowledgedEvent,
  createRefundIssuedEvent,
} from './event-factory.js'
import { EmptyEventLogError, fold, MixedBookingIdsError } from './fold.js'
import { toPaise } from './money.js'

const clock = new FrozenClock(new Date('2026-08-27T09:04:02+05:30'))
const STARTS_AT = new Date('2026-08-27T16:00:00+05:30')

function holdCreated(bookingId: string, sequence: number) {
  return createHoldCreatedEvent(bookingId, sequence, clock, {
    practitionerId: 'dr_rao',
    serviceId: 'svc_derm_consult',
    startsAt: STARTS_AT,
    ttlSeconds: 600,
  })
}

describe('fold', () => {
  it('folds a single HOLD_CREATED to HELD — the slice-0 acceptance test', () => {
    const state = fold([holdCreated('bkg_01', 1)])
    expect(state.status).toBe('HELD')
    expect(state.practitionerId).toBe('dr_rao')
    expect(state.startsAt).toEqual(STARTS_AT)
  })

  it('rejects an empty event list', () => {
    expect(() => fold([])).toThrow(EmptyEventLogError)
  })

  it('rejects events from more than one booking', () => {
    expect(() => fold([holdCreated('bkg_01', 1), holdCreated('bkg_02', 2)])).toThrow(MixedBookingIdsError)
  })

  it('is order-independent — sorts by sequence before folding', () => {
    const confirmed = createBookingConfirmedEvent('bkg_01', 2, clock, {})
    const held = holdCreated('bkg_01', 1)
    // passed out of order on purpose
    const state = fold([confirmed, held])
    expect(state.status).toBe('CONFIRMED')
  })

  it('folds the full happy path through to CONFIRMED', () => {
    const events = [
      holdCreated('bkg_01', 1),
      createPolicyAcknowledgedEvent('bkg_01', 2, clock, { policyVersion: 4 }),
      createDepositCapturedEvent('bkg_01', 3, clock, {
        action: { direction: 'credit', amountPaise: toPaise(30000), instrument: 'upi' },
        gate: { cleared: ['live_hold', 'policy_acked'], evidence: {} },
        bound: { ceilingPaise: toPaise(30000), enforcedBy: 'latch_policy', headroomAfterPaise: toPaise(0) },
        authority: { policyVersion: 4, razorpayPaymentId: 'pay_1' },
      }),
      createMandateRegisteredEvent('bkg_01', 4, clock, {
        mandateId: 'token_8812',
        ceilingPaise: toPaise(150000),
        expiresAt: new Date('2027-08-23T00:00:00Z'),
      }),
      createBookingConfirmedEvent('bkg_01', 5, clock, {}),
    ]
    const state = fold(events)
    expect(state.status).toBe('CONFIRMED')
    expect(state.policyVersion).toBe(4)
    expect(state.mandateId).toBe('token_8812')
    expect(state.lastEventSequence).toBe(5)
  })

  it('folds the merchant-decline failure path — the B5 trace', () => {
    const events = [
      holdCreated('bkg_01', 1),
      createBookingConfirmedEvent('bkg_01', 2, clock, {}),
      createMandateRegisteredEvent('bkg_01', 3, clock, {
        mandateId: 'token_8812',
        ceilingPaise: toPaise(150000),
        expiresAt: new Date('2027-08-23T00:00:00Z'),
      }),
      createMerchantDeclinedEvent('bkg_01', 4, clock, { reason: 'practitioner_unavailable' }),
      createRefundIssuedEvent('bkg_01', 5, clock, {
        action: { direction: 'debit', amountPaise: toPaise(30000), instrument: 'upi' },
        gate: { cleared: ['merchant_caused_cancellation'], evidence: {} },
        bound: { ceilingPaise: toPaise(30000), enforcedBy: 'latch_policy', headroomAfterPaise: toPaise(0) },
        authority: { policyVersion: 4, razorpayPaymentId: 'pay_1' },
      }),
      createMandateRevokedEvent('bkg_01', 6, clock, { mandateId: 'token_8812' }),
    ]
    const state = fold(events)
    expect(state.status).toBe('DECLINED_BY_MERCHANT')
    expect(state.mandateId).toBeUndefined() // revoked
  })

  it('folds through to NO_SHOW_CHARGED', () => {
    const events = [
      holdCreated('bkg_01', 1),
      createBookingConfirmedEvent('bkg_01', 2, clock, {}),
      createNoShowEligibleEvent('bkg_01', 3, clock, {}),
      createNoShowChargedEvent('bkg_01', 4, clock, {
        action: { direction: 'debit', amountPaise: toPaise(40000), instrument: 'upi_mandate' },
        gate: { cleared: ['start_time_elapsed', 'merchant_marked_non_attendance'], evidence: {} },
        bound: { ceilingPaise: toPaise(150000), enforcedBy: 'razorpay_mandate', headroomAfterPaise: toPaise(110000) },
        authority: { policyVersion: 4, mandateId: 'token_8812' },
      }),
    ]
    const state = fold(events)
    expect(state.status).toBe('NO_SHOW_CHARGED')
  })
})
