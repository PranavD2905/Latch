import { beforeAll, describe, expect, it } from 'vitest'
import { toPaise } from '../../domain/money.js'
import { PaymentTimeoutError } from '../../ports/payment-provider.js'
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
  it('captureDeposit replays the same real payment for a repeated idempotency key, without creating a new order', async () => {
    const provider = new RazorpayPaymentProvider({ keyId: keyId!, keySecret: keySecret! })

    const first = await provider.captureDeposit({
      amountPaise: DEPOSIT_AMOUNT_PAISE,
      idempotencyKey: KEEPER_IDEMPOTENCY_KEY,
      reference: 'live-test-keeper',
    })
    expect(first.paymentId).toBe(KEEPER_PAYMENT_ID)
    expect(first.amountPaise).toBe(30000)

    const second = await provider.captureDeposit({
      amountPaise: DEPOSIT_AMOUNT_PAISE,
      idempotencyKey: KEEPER_IDEMPOTENCY_KEY,
      reference: 'live-test-keeper',
    })
    expect(second.paymentId).toBe(first.paymentId)
  })

  it('captureDeposit throws PaymentTimeoutError for a fresh order nobody pays', async () => {
    const provider = new RazorpayPaymentProvider({
      keyId: keyId!,
      keySecret: keySecret!,
      captureTimeoutMs: 4000,
      capturePollIntervalMs: 1000,
    })

    await expect(
      provider.captureDeposit({
        amountPaise: DEPOSIT_AMOUNT_PAISE,
        idempotencyKey: `live-test-unpaid-${Date.now()}`,
        reference: 'live-test-unpaid',
      }),
    ).rejects.toThrow(PaymentTimeoutError)
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
})
