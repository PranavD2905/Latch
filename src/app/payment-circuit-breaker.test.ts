import { describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { PaymentDeclinedError, PaymentProviderError } from '../ports/payment-provider.js'
import { CaptureAmountMismatchError, PaymentRailError } from '../ports/payment-rail.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { executePaymentCall } from './payment-circuit-breaker.js'

describe('executePaymentCall', () => {
  it('counts PaymentProviderError/PaymentRailError toward the breaker\'s failure streak', async () => {
    const clock = new FrozenClock(new Date('2026-08-28T00:00:00Z'))
    const breaker = new CircuitBreaker({ name: 'test', clock, failureThreshold: 2, cooldownMs: 60_000 })

    await expect(executePaymentCall(breaker, () => Promise.reject(new PaymentProviderError('bkg_1', new Error('network fault'))))).rejects.toThrow(PaymentProviderError)
    await expect(executePaymentCall(breaker, () => Promise.reject(new PaymentRailError('bkg_1', new Error('network fault'))))).rejects.toThrow(PaymentRailError)
    expect(breaker.currentState).toBe('open')
  })

  it('does not count an ordinary business/gate outcome (declined, capture-amount-mismatch) toward the failure streak', async () => {
    const clock = new FrozenClock(new Date('2026-08-28T00:00:00Z'))
    const breaker = new CircuitBreaker({ name: 'test', clock, failureThreshold: 2, cooldownMs: 60_000 })

    await expect(executePaymentCall(breaker, () => Promise.reject(new PaymentDeclinedError('bkg_1')))).rejects.toThrow(PaymentDeclinedError)
    await expect(executePaymentCall(breaker, () => Promise.reject(new CaptureAmountMismatchError('bkg_1', 100)))).rejects.toThrow(CaptureAmountMismatchError)
    await expect(executePaymentCall(breaker, () => Promise.reject(new PaymentDeclinedError('bkg_1')))).rejects.toThrow(PaymentDeclinedError)
    expect(breaker.currentState).toBe('closed')

    // A real provider failure right after still opens it — proves these
    // rejections were excluded, not that the breaker stopped counting
    // altogether.
    await expect(executePaymentCall(breaker, () => Promise.reject(new PaymentProviderError('bkg_1', new Error('down'))))).rejects.toThrow(PaymentProviderError)
    await expect(executePaymentCall(breaker, () => Promise.reject(new PaymentProviderError('bkg_1', new Error('down'))))).rejects.toThrow(PaymentProviderError)
    expect(breaker.currentState).toBe('open')
  })

  it('when open, fails fast with CircuitOpenError instead of calling the underlying provider', async () => {
    const clock = new FrozenClock(new Date('2026-08-28T00:00:00Z'))
    const breaker = new CircuitBreaker({ name: 'test', clock, failureThreshold: 1, cooldownMs: 60_000 })

    await expect(executePaymentCall(breaker, () => Promise.reject(new PaymentProviderError('bkg_1', new Error('down'))))).rejects.toThrow(PaymentProviderError)

    let called = false
    await expect(
      executePaymentCall(breaker, () => {
        called = true
        return Promise.resolve('unreachable')
      }),
    ).rejects.toThrow('circuit "test" is open')
    expect(called).toBe(false)
  })
})
