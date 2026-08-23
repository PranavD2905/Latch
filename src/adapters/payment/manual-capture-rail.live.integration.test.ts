import { beforeAll, describe, expect, it } from 'vitest'
import { toPaise } from '../../domain/money.js'
import { PaymentRailError } from '../../ports/payment-rail.js'
import { ManualCaptureRail } from './manual-capture-rail.js'

/**
 * Hits real Razorpay test mode — no mocking, same convention as
 * razorpay-payment-provider.live.integration.test.ts. `authorize()` shares
 * that file's create-order-then-poll shape (dev-logs/006/007), so what it
 * proves live is the same class of thing: real order creation, against the
 * real API, with a real (short) timeout when nobody completes Checkout.
 *
 * What this file does *not* cover: an authorised payment actually landing
 * in `authorized` state, `captureAuthorization()` succeeding, and the real
 * "Capture amount must be equal to the amount authorized" refusal. Those
 * need a human to complete Checkout at least once (dev-logs/006/007) — no
 * such fixture exists yet for the no-show authorisation leg (unlike the
 * deposit leg's three fixture payments), since it would need a person
 * driving a real browser to create one. `fake-payment-rail.test.ts` proves
 * the same logic (including the item-7 ceiling refusal) fast and
 * deterministically in the meantime; `charge-no-show.integration.test.ts`
 * proves the full app-layer flow against that fake.
 */

process.loadEnvFile?.('.env')
const keyId = process.env['RAZORPAY_KEY_ID']
const keySecret = process.env['RAZORPAY_KEY_SECRET']

const NO_SHOW_FEE_PAISE = toPaise(40000)

beforeAll(() => {
  if (!keyId || !keySecret) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set — see razorpay-payment-provider.live.integration.test.ts for why this cannot be mocked.')
  }
})

describe('ManualCaptureRail — real Razorpay test mode', () => {
  it('authorize creates a real manual-capture order and times out with PaymentRailError when nobody completes Checkout', async () => {
    const rail = new ManualCaptureRail({ keyId: keyId!, keySecret: keySecret!, authorizeTimeoutMs: 4000, authorizePollIntervalMs: 1000 })

    await expect(
      rail.authorize({
        amountPaise: NO_SHOW_FEE_PAISE,
        idempotencyKey: `live-test-unpaid-auth-${Date.now()}`,
        reference: 'live-test-unpaid-authorization',
        now: new Date(),
      }),
    ).rejects.toThrow(PaymentRailError)
  }, 10_000)
})
