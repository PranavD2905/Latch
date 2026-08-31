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
 * What this file does *not* cover: an authorised payment actually landing
 * in `authorized` state, `captureAuthorization()` succeeding, and the real
 * "Capture amount must be equal to the amount authorized" refusal. Those
 * need a human to complete Checkout at least once (dev-logs/006/007) — no
 * such fixture exists yet for this authorisation leg (unlike the deposit
 * leg's three fixture payments), since it would need a person driving a
 * real browser to create one. `fake-payment-rail.test.ts` proves the same
 * logic (including the item-7 ceiling refusal) fast and deterministically
 * in the meantime; `confirm-with-deposit.fast.test.ts` proves the full
 * app-layer flow against that fake.
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
})
