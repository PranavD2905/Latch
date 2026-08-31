import { describe, expect, it } from 'vitest'
import { toPaise } from '../../domain/money.js'
import { PaymentDeclinedError } from '../../ports/payment-provider.js'
import { FakePaymentProvider } from './fake-payment-provider.js'

describe('FakePaymentProvider', () => {
  it('defaults to success', async () => {
    const provider = new FakePaymentProvider()
    const params = { amountPaise: toPaise(30000), idempotencyKey: 'k1', reference: 'bkg_1' }
    const order = await provider.ensureDepositOrder(params)
    const result = await provider.pollDepositCapture(order, params.reference)
    expect(result?.amountPaise).toBe(30000)
    expect(result?.paymentId).toMatch(/^pay_/)
  })

  it('simulates a decline', async () => {
    const provider = new FakePaymentProvider()
    provider.setScenario('k2', 'decline')
    const params = { amountPaise: toPaise(30000), idempotencyKey: 'k2', reference: 'bkg_2' }
    const order = await provider.ensureDepositOrder(params)
    await expect(provider.pollDepositCapture(order, params.reference)).rejects.toThrow(PaymentDeclinedError)
  })

  it('a pending scenario returns undefined — not paid yet is not an error', async () => {
    const provider = new FakePaymentProvider()
    provider.setScenario('k3', 'pending')
    const params = { amountPaise: toPaise(30000), idempotencyKey: 'k3', reference: 'bkg_3' }
    const order = await provider.ensureDepositOrder(params)
    await expect(provider.pollDepositCapture(order, params.reference)).resolves.toBeUndefined()
  })

  it('completeDeposit flips a pending scenario to captured, modelling a human paying the link later', async () => {
    const provider = new FakePaymentProvider()
    provider.setScenario('k4', 'pending')
    const params = { amountPaise: toPaise(30000), idempotencyKey: 'k4', reference: 'bkg_4' }
    const order = await provider.ensureDepositOrder(params)
    await expect(provider.pollDepositCapture(order, params.reference)).resolves.toBeUndefined()

    provider.completeDeposit('k4')
    const result = await provider.pollDepositCapture(order, params.reference)
    expect(result?.amountPaise).toBe(30000)
  })

  it('ensureDepositOrder is idempotent — a repeated call with the same key returns the same order, not a second one', async () => {
    const provider = new FakePaymentProvider()
    const params = { amountPaise: toPaise(30000), idempotencyKey: 'k5', reference: 'bkg_5' }
    const first = await provider.ensureDepositOrder(params)
    const second = await provider.ensureDepositOrder(params)
    expect(second.orderId).toBe(first.orderId)
  })

  it('replays the stored result for a repeated poll against the same order instead of charging again', async () => {
    const provider = new FakePaymentProvider()
    const params = { amountPaise: toPaise(30000), idempotencyKey: 'k6', reference: 'bkg_6' }
    const order = await provider.ensureDepositOrder(params)
    const first = await provider.pollDepositCapture(order, params.reference)
    const second = await provider.pollDepositCapture(order, params.reference)
    expect(second?.paymentId).toBe(first?.paymentId)
  })

  it('payDepositViaUpiCollect captures for any VPA except the magic failure one, mirroring real Razorpay test mode', async () => {
    const provider = new FakePaymentProvider()
    const params = { amountPaise: toPaise(30000), idempotencyKey: 'k8', reference: 'bkg_8' }
    const order = await provider.ensureDepositOrder(params)
    const result = await provider.payDepositViaUpiCollect(order, 'someone@okhdfcbank', params.reference)
    expect(result?.amountPaise).toBe(30000)
    expect(result?.instrument).toBe('upi')
  })

  it('payDepositViaUpiCollect declines for the magic failure VPA', async () => {
    const provider = new FakePaymentProvider()
    const params = { amountPaise: toPaise(30000), idempotencyKey: 'k9', reference: 'bkg_9' }
    const order = await provider.ensureDepositOrder(params)
    await expect(provider.payDepositViaUpiCollect(order, 'failure@razorpay', params.reference)).rejects.toThrow(PaymentDeclinedError)
  })

  it('refunds, and replays the stored refund result for a repeated idempotency key', async () => {
    const provider = new FakePaymentProvider()
    const first = await provider.refundDeposit({ paymentId: 'pay_x', amountPaise: toPaise(30000), idempotencyKey: 'k7', reference: 'bkg_7' })
    expect(first.refundId).toMatch(/^rfnd_/)
    const second = await provider.refundDeposit({ paymentId: 'pay_x', amountPaise: toPaise(30000), idempotencyKey: 'k7', reference: 'bkg_7' })
    expect(second.refundId).toBe(first.refundId)
  })
})
