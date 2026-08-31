import { describe, expect, it } from 'vitest'
import { toPaise } from '../../domain/money.js'
import { AuthorizationNotFoundError, CaptureAmountMismatchError, PaymentRailError } from '../../ports/payment-rail.js'
import { FakePaymentRail } from './fake-payment-rail.js'

const NOW = new Date('2026-08-25T00:00:00+05:30')

describe('FakePaymentRail', () => {
  it('defaults to success, authorising exactly the requested amount', async () => {
    const rail = new FakePaymentRail()
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k1', reference: 'bkg_1', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    const result = await rail.pollAuthorization(order, params.reference, NOW)
    expect(result?.amountPaise).toBe(40000)
    expect(result?.authorizationId).toMatch(/^pay_/)
    expect(result!.expiresAt.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('simulates a declined authorization', async () => {
    const rail = new FakePaymentRail()
    rail.setScenario('k2', 'decline')
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k2', reference: 'bkg_2', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    await expect(rail.pollAuthorization(order, params.reference, NOW)).rejects.toThrow(PaymentRailError)
  })

  it('a pending scenario returns undefined — not authorised yet is not an error', async () => {
    const rail = new FakePaymentRail()
    rail.setScenario('k3', 'pending')
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k3', reference: 'bkg_3', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    await expect(rail.pollAuthorization(order, params.reference, NOW)).resolves.toBeUndefined()
  })

  it('completeAuthorization flips a pending scenario to authorised, modelling a human paying the link later', async () => {
    const rail = new FakePaymentRail()
    rail.setScenario('k9', 'pending')
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k9', reference: 'bkg_9', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    await expect(rail.pollAuthorization(order, params.reference, NOW)).resolves.toBeUndefined()

    rail.completeAuthorization('k9')
    const result = await rail.pollAuthorization(order, params.reference, NOW)
    expect(result?.amountPaise).toBe(40000)
  })

  it('ensureAuthorizationOrder is idempotent — a repeated call with the same key returns the same order, not a second one', async () => {
    const rail = new FakePaymentRail()
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k10', reference: 'bkg_10', now: NOW }
    const first = await rail.ensureAuthorizationOrder(params)
    const second = await rail.ensureAuthorizationOrder(params)
    expect(second.orderId).toBe(first.orderId)
  })

  it('replays the stored authorization for a repeated poll against the same order instead of authorising again', async () => {
    const rail = new FakePaymentRail()
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k4', reference: 'bkg_4', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    const first = await rail.pollAuthorization(order, params.reference, NOW)
    const second = await rail.pollAuthorization(order, params.reference, NOW)
    expect(second?.authorizationId).toBe(first?.authorizationId)
  })

  it('captures an authorization in full when the amount matches exactly', async () => {
    const rail = new FakePaymentRail()
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k5', reference: 'bkg_5', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    const authorized = await rail.pollAuthorization(order, params.reference, NOW)
    const captured = await rail.captureAuthorization({ authorizationId: authorized!.authorizationId, amountPaise: toPaise(40000), reference: 'bkg_5' })
    expect(captured.paymentId).toBe(authorized!.authorizationId)
    expect(captured.amountPaise).toBe(40000)
  })

  it('replays the same capture result on a repeated call — no double-capture', async () => {
    const rail = new FakePaymentRail()
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k6', reference: 'bkg_6', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    const authorized = await rail.pollAuthorization(order, params.reference, NOW)
    const first = await rail.captureAuthorization({ authorizationId: authorized!.authorizationId, amountPaise: toPaise(40000), reference: 'bkg_6' })
    const second = await rail.captureAuthorization({ authorizationId: authorized!.authorizationId, amountPaise: toPaise(40000), reference: 'bkg_6' })
    expect(second).toEqual(first)
  })

  it('refuses a capture that is not exactly the authorised amount — the item-7 ceiling demo', async () => {
    const rail = new FakePaymentRail()
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k7', reference: 'bkg_7', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    const authorized = await rail.pollAuthorization(order, params.reference, NOW)
    await expect(
      rail.captureAuthorization({ authorizationId: authorized!.authorizationId, amountPaise: toPaise(40001), reference: 'bkg_7' }),
    ).rejects.toThrow(CaptureAmountMismatchError)
  })

  it('refuses to capture an authorization that was never authorised', async () => {
    const rail = new FakePaymentRail()
    await expect(rail.captureAuthorization({ authorizationId: 'pay_does_not_exist', amountPaise: toPaise(40000), reference: 'bkg_8' })).rejects.toThrow(
      AuthorizationNotFoundError,
    )
  })

  it('authorizeViaUpiCollect authorises for any VPA except the magic failure one, and the captured instrument reflects it', async () => {
    const rail = new FakePaymentRail()
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k11', reference: 'bkg_11', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    const authorized = await rail.authorizeViaUpiCollect(order, 'someone@okhdfcbank', params.reference, NOW)
    expect(authorized?.amountPaise).toBe(40000)
    const captured = await rail.captureAuthorization({ authorizationId: authorized!.authorizationId, amountPaise: toPaise(40000), reference: 'bkg_11' })
    expect(captured.instrument).toBe('upi')
  })

  it('authorizeViaUpiCollect declines for the magic failure VPA', async () => {
    const rail = new FakePaymentRail()
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k12', reference: 'bkg_12', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    await expect(rail.authorizeViaUpiCollect(order, 'failure@razorpay', params.reference, NOW)).rejects.toThrow(PaymentRailError)
  })

  it('the ceiling refusal holds identically for a UPI-authorised payment', async () => {
    const rail = new FakePaymentRail()
    const params = { amountPaise: toPaise(40000), idempotencyKey: 'k13', reference: 'bkg_13', now: NOW }
    const order = await rail.ensureAuthorizationOrder(params)
    const authorized = await rail.authorizeViaUpiCollect(order, 'success@razorpay', params.reference, NOW)
    await expect(
      rail.captureAuthorization({ authorizationId: authorized!.authorizationId, amountPaise: toPaise(40001), reference: 'bkg_13' }),
    ).rejects.toThrow(CaptureAmountMismatchError)
  })
})
