import { describe, expect, it } from 'vitest'
import { toPaise } from '../../domain/money.js'
import { AuthorizationNotFoundError, CaptureAmountMismatchError, PaymentRailError } from '../../ports/payment-rail.js'
import { FakePaymentRail } from './fake-payment-rail.js'

const NOW = new Date('2026-08-25T00:00:00+05:30')

describe('FakePaymentRail', () => {
  it('defaults to success, authorising exactly the requested amount', async () => {
    const rail = new FakePaymentRail()
    const result = await rail.authorize({ amountPaise: toPaise(40000), idempotencyKey: 'k1', reference: 'bkg_1', now: NOW })
    expect(result.amountPaise).toBe(40000)
    expect(result.authorizationId).toMatch(/^pay_/)
    expect(result.expiresAt.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('simulates a declined authorization', async () => {
    const rail = new FakePaymentRail()
    rail.setScenario('k2', 'decline')
    await expect(rail.authorize({ amountPaise: toPaise(40000), idempotencyKey: 'k2', reference: 'bkg_2', now: NOW })).rejects.toThrow(PaymentRailError)
  })

  it('simulates an authorization timeout', async () => {
    const rail = new FakePaymentRail()
    rail.setScenario('k3', 'timeout')
    await expect(rail.authorize({ amountPaise: toPaise(40000), idempotencyKey: 'k3', reference: 'bkg_3', now: NOW })).rejects.toThrow(PaymentRailError)
  })

  it('replays the stored authorization for a repeated idempotency key instead of authorising again', async () => {
    const rail = new FakePaymentRail()
    const first = await rail.authorize({ amountPaise: toPaise(40000), idempotencyKey: 'k4', reference: 'bkg_4', now: NOW })
    const second = await rail.authorize({ amountPaise: toPaise(40000), idempotencyKey: 'k4', reference: 'bkg_4', now: NOW })
    expect(second.authorizationId).toBe(first.authorizationId)
  })

  it('captures an authorization in full when the amount matches exactly', async () => {
    const rail = new FakePaymentRail()
    const authorized = await rail.authorize({ amountPaise: toPaise(40000), idempotencyKey: 'k5', reference: 'bkg_5', now: NOW })
    const captured = await rail.captureAuthorization({ authorizationId: authorized.authorizationId, amountPaise: toPaise(40000), reference: 'bkg_5' })
    expect(captured.paymentId).toBe(authorized.authorizationId)
    expect(captured.amountPaise).toBe(40000)
  })

  it('replays the same capture result on a repeated call — no double-capture', async () => {
    const rail = new FakePaymentRail()
    const authorized = await rail.authorize({ amountPaise: toPaise(40000), idempotencyKey: 'k6', reference: 'bkg_6', now: NOW })
    const first = await rail.captureAuthorization({ authorizationId: authorized.authorizationId, amountPaise: toPaise(40000), reference: 'bkg_6' })
    const second = await rail.captureAuthorization({ authorizationId: authorized.authorizationId, amountPaise: toPaise(40000), reference: 'bkg_6' })
    expect(second).toEqual(first)
  })

  it('refuses a capture that is not exactly the authorised amount — the item-7 ceiling demo', async () => {
    const rail = new FakePaymentRail()
    const authorized = await rail.authorize({ amountPaise: toPaise(40000), idempotencyKey: 'k7', reference: 'bkg_7', now: NOW })
    await expect(
      rail.captureAuthorization({ authorizationId: authorized.authorizationId, amountPaise: toPaise(40001), reference: 'bkg_7' }),
    ).rejects.toThrow(CaptureAmountMismatchError)
  })

  it('refuses to capture an authorization that was never authorised', async () => {
    const rail = new FakePaymentRail()
    await expect(rail.captureAuthorization({ authorizationId: 'pay_does_not_exist', amountPaise: toPaise(40000), reference: 'bkg_8' })).rejects.toThrow(
      AuthorizationNotFoundError,
    )
  })
})
