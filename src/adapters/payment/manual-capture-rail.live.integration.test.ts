import { beforeAll, describe, expect, it } from 'vitest'
import { toPaise } from '../../domain/money.js'
import { ManualCaptureRail } from './manual-capture-rail.js'

/**
 * Hits real Razorpay test mode — no mocking, same convention as
 * razorpay-payment-provider.live.integration.test.ts. `ensureAuthorizationOrder`/
 * `pollAuthorization` share that file's create-order-then-poll shape
 * (dev-logs/006/007), so what it proves live is the same class of thing:
 * real order creation, against the real API, with a real (short) poll that
 * returns `undefined` rather than throwing when nobody completes Checkout.
 *
 * `authorizeViaUpiCollect` (below) closes a gap this file's comment used to
 * name here: an authorised payment actually landing in `authorized` state,
 * `captureAuthorization()` succeeding, and the real "Capture amount must be
 * equal to the amount authorized" refusal all used to need a human
 * completing Checkout at least once, with no such fixture existing for this
 * leg. UPI collect S2S makes all three provable directly, live, no human —
 * verified before writing the adapter method that a manual-capture order
 * paid this way really does land as `authorized`/`captured: false`, that a
 * same-amount capture succeeds, and that refunding it *before* capture is
 * refused ("payment status should be captured for action to be taken") —
 * the same property that makes release-by-lapse cost the customer ₹0.
 */

process.loadEnvFile?.('.env')
const keyId = process.env['RAZORPAY_KEY_ID']
const keySecret = process.env['RAZORPAY_KEY_SECRET']

const AUTHORIZATION_AMOUNT_PAISE = toPaise(40000)

beforeAll(() => {
  if (!keyId || !keySecret) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set — see razorpay-payment-provider.live.integration.test.ts for why this cannot be mocked.')
  }
})

describe('ManualCaptureRail — real Razorpay test mode', () => {
  it('ensureAuthorizationOrder creates a real manual-capture order fast, without waiting for a payment', async () => {
    const rail = new ManualCaptureRail({ keyId: keyId!, keySecret: keySecret! })

    const order = await rail.ensureAuthorizationOrder({
      amountPaise: AUTHORIZATION_AMOUNT_PAISE,
      idempotencyKey: `live-test-order-auth-${Date.now()}`,
      reference: 'live-test-order-authorization',
      now: new Date(),
    })
    expect(order.orderId).toMatch(/^order_/)
    expect(order.amountPaise).toBe(40000)
  })

  it('pollAuthorization returns undefined — never throws — when nobody completes Checkout', async () => {
    const rail = new ManualCaptureRail({ keyId: keyId!, keySecret: keySecret! })

    const now = new Date()
    const order = await rail.ensureAuthorizationOrder({
      amountPaise: AUTHORIZATION_AMOUNT_PAISE,
      idempotencyKey: `live-test-unpaid-auth-${Date.now()}`,
      reference: 'live-test-unpaid-authorization',
      now,
    })
    const result = await rail.pollAuthorization(order, 'live-test-unpaid-authorization', now, { timeoutMs: 4000 })
    expect(result).toBeUndefined()
  }, 10_000)

  describe('authorizeViaUpiCollect — real UPI collect S2S', () => {
    it('authorises for the magic success VPA, then a same-amount capture succeeds and a mismatched one is refused — the item-7 ceiling, live', async () => {
      const rail = new ManualCaptureRail({ keyId: keyId!, keySecret: keySecret! })
      const now = new Date()
      const order = await rail.ensureAuthorizationOrder({
        amountPaise: AUTHORIZATION_AMOUNT_PAISE,
        idempotencyKey: `live-test-upi-auth-success-${Date.now()}`,
        reference: 'live-test-upi-auth-success',
        now,
      })

      const authorized = await rail.authorizeViaUpiCollect(order, 'success@razorpay', 'live-test-upi-auth-success', now, { timeoutMs: 8000 })
      expect(authorized?.authorizationId).toMatch(/^pay_/)
      expect(authorized?.amountPaise).toBe(40000)

      await expect(
        rail.captureAuthorization({ authorizationId: authorized!.authorizationId, amountPaise: toPaise(40001), reference: 'live-test-upi-auth-success' }),
      ).rejects.toThrow('does not equal the amount authorized')

      const captured = await rail.captureAuthorization({ authorizationId: authorized!.authorizationId, amountPaise: AUTHORIZATION_AMOUNT_PAISE, reference: 'live-test-upi-auth-success' })
      expect(captured.amountPaise).toBe(40000)
      expect(captured.instrument).toBe('upi')
    }, 20_000)

    it('declines for the magic failure VPA', async () => {
      const rail = new ManualCaptureRail({ keyId: keyId!, keySecret: keySecret! })
      const now = new Date()
      const order = await rail.ensureAuthorizationOrder({
        amountPaise: AUTHORIZATION_AMOUNT_PAISE,
        idempotencyKey: `live-test-upi-auth-failure-${Date.now()}`,
        reference: 'live-test-upi-auth-failure',
        now,
      })

      await expect(rail.authorizeViaUpiCollect(order, 'failure@razorpay', 'live-test-upi-auth-failure', now, { timeoutMs: 8000 })).rejects.toThrow()
    }, 15_000)
  })
})
