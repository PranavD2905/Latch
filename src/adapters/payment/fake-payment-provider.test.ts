import { describe, expect, it } from 'vitest'
import { toPaise } from '../../domain/money.js'
import { PaymentDeclinedError, PaymentTimeoutError } from '../../ports/payment-provider.js'
import { FakePaymentProvider } from './fake-payment-provider.js'

describe('FakePaymentProvider', () => {
  it('defaults to success', async () => {
    const provider = new FakePaymentProvider()
    const result = await provider.captureDeposit({ amountPaise: toPaise(30000), idempotencyKey: 'k1', reference: 'bkg_1' })
    expect(result.amountPaise).toBe(30000)
    expect(result.paymentId).toMatch(/^pay_/)
  })

  it('simulates a decline', async () => {
    const provider = new FakePaymentProvider()
    provider.setScenario('k2', 'decline')
    await expect(provider.captureDeposit({ amountPaise: toPaise(30000), idempotencyKey: 'k2', reference: 'bkg_2' })).rejects.toThrow(
      PaymentDeclinedError,
    )
  })

  it('simulates a timeout', async () => {
    const provider = new FakePaymentProvider()
    provider.setScenario('k3', 'timeout')
    await expect(provider.captureDeposit({ amountPaise: toPaise(30000), idempotencyKey: 'k3', reference: 'bkg_3' })).rejects.toThrow(
      PaymentTimeoutError,
    )
  })

  it('replays the stored result for a repeated idempotency key instead of charging again', async () => {
    const provider = new FakePaymentProvider()
    const first = await provider.captureDeposit({ amountPaise: toPaise(30000), idempotencyKey: 'k5', reference: 'bkg_5' })
    const second = await provider.captureDeposit({ amountPaise: toPaise(30000), idempotencyKey: 'k5', reference: 'bkg_5' })
    expect(second.paymentId).toBe(first.paymentId)
  })

  it('refunds, and replays the stored refund result for a repeated idempotency key', async () => {
    const provider = new FakePaymentProvider()
    const first = await provider.refundDeposit({ paymentId: 'pay_x', amountPaise: toPaise(30000), idempotencyKey: 'k6', reference: 'bkg_6' })
    expect(first.refundId).toMatch(/^rfnd_/)
    const second = await provider.refundDeposit({ paymentId: 'pay_x', amountPaise: toPaise(30000), idempotencyKey: 'k6', reference: 'bkg_6' })
    expect(second.refundId).toBe(first.refundId)
  })
})
