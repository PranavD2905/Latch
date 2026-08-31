import { ulid } from 'ulid'
import { describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import {
  createBookingConfirmedEvent,
  createDepositCapturedEvent,
  createHoldCreatedEvent,
  createMerchantDeclinedEvent,
  createPolicyAcknowledgedEvent,
  createRefundIssuedEvent,
} from './event-factory.js'
import type { AuthorizationHeldEvent, AuthorizationReleasedEvent, NoShowChargedEvent, NoShowEligibleEvent } from './events.js'
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

/**
 * The no-show feature is removed (see the dev log for that removal) — there
 * is no longer a `createAuthorizationHeldEvent`/`createNoShowChargedEvent`/
 * etc. factory, deliberately, since nothing should ever construct one of
 * these again. These four local helpers exist only so this file can still
 * prove `fold()` correctly replays a pre-removal booking's history — the
 * exact historical-replay guarantee that removal preserved. Hand-built
 * rather than routed through a factory, on purpose: these events are frozen
 * historical shapes now, not something new code paths produce.
 */
function authorizationHeld(bookingId: string, sequence: number, fields: Omit<AuthorizationHeldEvent, 'eventId' | 'bookingId' | 'occurredAt' | 'sequence' | 'type'>): AuthorizationHeldEvent {
  return { eventId: ulid(), bookingId, occurredAt: clock.now(), sequence, type: 'AUTHORIZATION_HELD', ...fields }
}
function authorizationReleased(bookingId: string, sequence: number, fields: Omit<AuthorizationReleasedEvent, 'eventId' | 'bookingId' | 'occurredAt' | 'sequence' | 'type'>): AuthorizationReleasedEvent {
  return { eventId: ulid(), bookingId, occurredAt: clock.now(), sequence, type: 'AUTHORIZATION_RELEASED', ...fields }
}
function noShowEligible(bookingId: string, sequence: number): NoShowEligibleEvent {
  return { eventId: ulid(), bookingId, occurredAt: clock.now(), sequence, type: 'NO_SHOW_ELIGIBLE' }
}
function noShowCharged(bookingId: string, sequence: number, fields: Omit<NoShowChargedEvent, 'eventId' | 'bookingId' | 'occurredAt' | 'sequence' | 'type'>): NoShowChargedEvent {
  return { eventId: ulid(), bookingId, occurredAt: clock.now(), sequence, type: 'NO_SHOW_CHARGED', ...fields }
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
      authorizationHeld('bkg_01', 4, {
        authorizationId: 'pay_Auth991',
        amountPaise: toPaise(40000),
        expiresAt: new Date('2027-08-23T00:00:00Z'),
        rail: 'manual_capture',
        enforcedBy: 'payment_rail',
        policyVersion: 4,
      }),
      createBookingConfirmedEvent('bkg_01', 5, clock, {}),
    ]
    const state = fold(events)
    expect(state.status).toBe('CONFIRMED')
    expect(state.policyVersion).toBe(4)
    expect(state.authorizationId).toBe('pay_Auth991')
    expect(state.lastEventSequence).toBe(5)
  })

  it('folds the merchant-decline failure path — the B5 trace', () => {
    const events = [
      holdCreated('bkg_01', 1),
      createBookingConfirmedEvent('bkg_01', 2, clock, {}),
      authorizationHeld('bkg_01', 3, {
        authorizationId: 'pay_Auth991',
        amountPaise: toPaise(40000),
        expiresAt: new Date('2027-08-23T00:00:00Z'),
        rail: 'manual_capture',
        enforcedBy: 'payment_rail',
        policyVersion: 4,
      }),
      createMerchantDeclinedEvent('bkg_01', 4, clock, { reason: 'practitioner_unavailable', cause: 'MERCHANT' }),
      createRefundIssuedEvent('bkg_01', 5, clock, {
        action: { direction: 'debit', amountPaise: toPaise(30000), instrument: 'upi' },
        gate: { cleared: ['merchant_caused_cancellation'], evidence: {} },
        bound: { ceilingPaise: toPaise(30000), enforcedBy: 'latch_policy', headroomAfterPaise: toPaise(0) },
        authority: { policyVersion: 4, razorpayPaymentId: 'pay_1' },
      }),
      authorizationReleased('bkg_01', 6, {
        authorizationId: 'pay_Auth991',
        rail: 'manual_capture',
        expiresAt: new Date('2027-08-23T00:00:00Z'),
      }),
    ]
    const state = fold(events)
    expect(state.status).toBe('DECLINED_BY_MERCHANT')
    expect(state.authorizationId).toBeUndefined() // released
  })

  it('folds through to NO_SHOW_CHARGED — historical-only since the no-show feature was removed, but a pre-removal booking\'s history must still replay to its true recorded state', () => {
    const events = [
      holdCreated('bkg_01', 1),
      createBookingConfirmedEvent('bkg_01', 2, clock, {}),
      noShowEligible('bkg_01', 3),
      noShowCharged('bkg_01', 4, {
        rail: 'manual_capture',
        action: { direction: 'debit', amountPaise: toPaise(40000), instrument: 'card' },
        gate: { cleared: ['start_time_elapsed', 'merchant_marked_non_attendance'], evidence: {} },
        bound: { ceilingPaise: toPaise(40000), enforcedBy: 'payment_rail', headroomAfterPaise: toPaise(0) },
        authority: { policyVersion: 4, authorizationId: 'pay_Auth991' },
      }),
    ]
    const state = fold(events)
    expect(state.status).toBe('NO_SHOW_CHARGED')
  })
})
