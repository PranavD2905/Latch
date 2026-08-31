import { beforeAll, describe, expect, it } from 'vitest'
import { toPaise } from '../../domain/money.js'
import { RazorpayPaymentProvider } from './razorpay-payment-provider.js'

/**
 * Hits the real Razorpay test-mode API — no mocking. Consistent with this
 * project's existing convention (schema.integration.test.ts,
 * booking-flow.integration.test.ts) of integration tests exercising real
 * infrastructure rather than fakes; Razorpay test mode is infrastructure
 * here the same way Postgres is.
 *
 * The three fixture payments below were captured once, live, by a human
 * completing real Razorpay Checkout (card method — this test-mode account
 * has no UPI method enabled, and no server-to-server way to submit a
 * payment without Razorpay support enabling TPV — see dev-logs/006 for the
 * full story of why). They are permanent Razorpay test-mode records, not
 * regenerated per run:
 *
 * - `pay_TTFBnuP13ONyNb` (order receipt `latch-fixture-captured-deposit`,
 *   ₹300, captured) — proves idempotent replay via receipt lookup. Never
 *   refunded by any test here, because that would flip its status away
 *   from `captured` and break this fixture for every future run.
 * - `pay_TTFUhHVTQOyr0o` (order receipt `latch-live-test-refund-key`,
 *   ₹300, captured) — dedicated refund fixture. The first-ever run of the
 *   refund test actually refunds it for real; every run after that finds
 *   the same refund via receipt lookup and makes no new mutation, so this
 *   file is safe to run repeatedly.
 */

process.loadEnvFile?.('.env')
const keyId = process.env['RAZORPAY_KEY_ID']
const keySecret = process.env['RAZORPAY_KEY_SECRET']

const DEPOSIT_AMOUNT_PAISE = toPaise(30000)
const KEEPER_PAYMENT_ID = 'pay_TTFBnuP13ONyNb'
const KEEPER_IDEMPOTENCY_KEY = 'latch-fixture-captured-deposit'
const REFUND_FIXTURE_PAYMENT_ID = 'pay_TTFUhHVTQOyr0o'
const REFUND_IDEMPOTENCY_KEY = 'latch-live-test-refund-key'

beforeAll(() => {
  if (!keyId || !keySecret) {
    throw new Error(
      'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set. This live integration test needs real Razorpay test-mode ' +
        'credentials in .env (see .env.example) — it is not mockable, per this project\'s convention of testing ' +
        'adapters against real infrastructure.',
    )
  }
})

describe('RazorpayPaymentProvider — real Razorpay test mode', () => {
  it('ensureDepositOrder is idempotent by receipt — a repeated call with the same key finds the same real order, never creates a second one', async () => {
    const provider = new RazorpayPaymentProvider({ keyId: keyId!, keySecret: keySecret! })

    const first = await provider.ensureDepositOrder({ amountPaise: DEPOSIT_AMOUNT_PAISE, idempotencyKey: KEEPER_IDEMPOTENCY_KEY, reference: 'live-test-keeper' })
    const second = await provider.ensureDepositOrder({ amountPaise: DEPOSIT_AMOUNT_PAISE, idempotencyKey: KEEPER_IDEMPOTENCY_KEY, reference: 'live-test-keeper' })
    expect(second.orderId).toBe(first.orderId)
  })

  it('pollDepositCapture finds the real captured payment already sitting on the keeper order', async () => {
    const provider = new RazorpayPaymentProvider({ keyId: keyId!, keySecret: keySecret! })

    const order = await provider.ensureDepositOrder({ amountPaise: DEPOSIT_AMOUNT_PAISE, idempotencyKey: KEEPER_IDEMPOTENCY_KEY, reference: 'live-test-keeper' })
    const result = await provider.pollDepositCapture(order, 'live-test-keeper')
    expect(result?.paymentId).toBe(KEEPER_PAYMENT_ID)
    expect(result?.amountPaise).toBe(30000)
  })

  it('ensureDepositOrder creates a real order fast, without waiting for a payment', async () => {
    const provider = new RazorpayPaymentProvider({ keyId: keyId!, keySecret: keySecret! })

    const order = await provider.ensureDepositOrder({
      amountPaise: DEPOSIT_AMOUNT_PAISE,
      idempotencyKey: `live-test-order-${Date.now()}`,
      reference: 'live-test-order',
    })
    expect(order.orderId).toMatch(/^order_/)
    expect(order.amountPaise).toBe(30000)
  })

  it('pollDepositCapture returns undefined — never throws — for a fresh order nobody pays', async () => {
    const provider = new RazorpayPaymentProvider({ keyId: keyId!, keySecret: keySecret! })

    const order = await provider.ensureDepositOrder({
      amountPaise: DEPOSIT_AMOUNT_PAISE,
      idempotencyKey: `live-test-unpaid-${Date.now()}`,
      reference: 'live-test-unpaid',
    })
    const result = await provider.pollDepositCapture(order, 'live-test-unpaid', { timeoutMs: 4000 })
    expect(result).toBeUndefined()
  }, 10_000)

  it('refundDeposit is idempotent against Razorpay: same key never produces a second refund', async () => {
    const provider = new RazorpayPaymentProvider({ keyId: keyId!, keySecret: keySecret! })

    const first = await provider.refundDeposit({
      paymentId: REFUND_FIXTURE_PAYMENT_ID,
      amountPaise: DEPOSIT_AMOUNT_PAISE,
      idempotencyKey: REFUND_IDEMPOTENCY_KEY,
      reference: 'live-test-refund',
    })
    expect(first.refundId).toMatch(/^rfnd_/)
    expect(first.amountPaise).toBe(30000)

    const second = await provider.refundDeposit({
      paymentId: REFUND_FIXTURE_PAYMENT_ID,
      amountPaise: DEPOSIT_AMOUNT_PAISE,
      idempotencyKey: REFUND_IDEMPOTENCY_KEY,
      reference: 'live-test-refund',
    })
    expect(second.refundId).toBe(first.refundId)
  })

  /**
   * `payDepositViaUpiCollect` — this account had TPV enabled for UPI collect
   * (`/payments/create/upi`) after dev-logs/006/029 were written; both
   * verified this exact endpoint 404ing at the time. Re-verified live before
   * writing the adapter method: a full round trip against
   * `POST /v1/payments/create/upi` with `success@razorpay` returns
   * `HTTP 200`, and the resulting payment reads back `captured` within a
   * couple of seconds — no Checkout.js, no browser, no human. Card S2S
   * (`/payments/create/json`) is still 404 on this account, checked the same
   * way — not covered by this method or this test.
   */
  describe('payDepositViaUpiCollect — real UPI collect S2S', () => {
    it('captures for the magic success VPA, no Checkout involved', async () => {
      const provider = new RazorpayPaymentProvider({ keyId: keyId!, keySecret: keySecret! })
      const order = await provider.ensureDepositOrder({
        amountPaise: DEPOSIT_AMOUNT_PAISE,
        idempotencyKey: `live-test-upi-success-${Date.now()}`,
        reference: 'live-test-upi-success',
      })

      const result = await provider.payDepositViaUpiCollect(order, 'success@razorpay', 'live-test-upi-success', { timeoutMs: 8000 })

      expect(result?.paymentId).toMatch(/^pay_/)
      expect(result?.amountPaise).toBe(30000)
      expect(result?.instrument).toBe('upi')
    }, 15_000)

    it('declines for the magic failure VPA', async () => {
      const provider = new RazorpayPaymentProvider({ keyId: keyId!, keySecret: keySecret! })
      const order = await provider.ensureDepositOrder({
        amountPaise: DEPOSIT_AMOUNT_PAISE,
        idempotencyKey: `live-test-upi-failure-${Date.now()}`,
        reference: 'live-test-upi-failure',
      })

      await expect(provider.payDepositViaUpiCollect(order, 'failure@razorpay', 'live-test-upi-failure', { timeoutMs: 8000 })).rejects.toThrow('Payment declined')
    }, 15_000)
  })
})
