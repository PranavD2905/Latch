import { describe, expect, it } from 'vitest'
import { FrozenClock } from '../adapters/clock/frozen-clock.js'
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js'

function failing(message = 'boom'): () => Promise<never> {
  return () => Promise.reject(new Error(message))
}

function succeeding<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value)
}

describe('CircuitBreaker', () => {
  it('stays closed and lets calls through below the failure threshold', async () => {
    const clock = new FrozenClock(new Date('2026-08-26T00:00:00Z'))
    const breaker = new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 60_000 })

    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    expect(breaker.currentState).toBe('closed')

    // A success below the threshold resets the streak — this is not "3
    // failures ever," it's 3 *consecutive*.
    await expect(breaker.execute(succeeding('ok'))).resolves.toBe('ok')
    expect(breaker.currentState).toBe('closed')
  })

  it('opens after `failureThreshold` consecutive failures and rejects locally without calling `fn` again', async () => {
    const clock = new FrozenClock(new Date('2026-08-26T00:00:00Z'))
    const breaker = new CircuitBreaker({ name: 'test', clock, failureThreshold: 3, cooldownMs: 60_000 })

    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    expect(breaker.currentState).toBe('open')

    let called = false
    await expect(
      breaker.execute(async () => {
        called = true
        return 'unreachable'
      }),
    ).rejects.toThrow(CircuitOpenError)
    expect(called).toBe(false)
  })

  it('stays open until the cooldown elapses, then allows exactly one half-open probe', async () => {
    const clock = new FrozenClock(new Date('2026-08-26T00:00:00Z'))
    const breaker = new CircuitBreaker({ name: 'test', clock, failureThreshold: 1, cooldownMs: 120_000 })

    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    expect(breaker.currentState).toBe('open')

    clock.advance(119_999)
    await expect(breaker.execute(succeeding('too soon'))).rejects.toThrow(CircuitOpenError)

    clock.advance(2) // now 120_001ms since opening — past the cooldown
    await expect(breaker.execute(succeeding('probe'))).resolves.toBe('probe')
    expect(breaker.currentState).toBe('closed')
  })

  it('a failed half-open probe reopens immediately, without needing another full failureThreshold streak', async () => {
    const clock = new FrozenClock(new Date('2026-08-26T00:00:00Z'))
    const breaker = new CircuitBreaker({ name: 'test', clock, failureThreshold: 5, cooldownMs: 60_000 })

    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    await expect(breaker.execute(failing())).rejects.toThrow('boom')
    expect(breaker.currentState).toBe('open')

    clock.advance(60_001)
    // The probe itself fails — reopens on this one failure, not after 5 more.
    await expect(breaker.execute(failing('still down'))).rejects.toThrow('still down')
    expect(breaker.currentState).toBe('open')

    clock.advance(1) // still inside the fresh cooldown that reopening just started
    await expect(breaker.execute(succeeding('too soon again'))).rejects.toThrow(CircuitOpenError)
  })
})
