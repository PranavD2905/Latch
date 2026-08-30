import { describe, expect, it } from 'vitest'
import { FakeIdempotencyStore } from './fake-idempotency-store.js'

describe('FakeIdempotencyStore', () => {
  it('get returns undefined for a key nothing has stored', async () => {
    const store = new FakeIdempotencyStore()
    expect(await store.get('scope', 'k1')).toBeUndefined()
  })

  it('put then get replays the stored response', async () => {
    const store = new FakeIdempotencyStore()
    await store.put('scope', 'k2', { bookingId: 'bkg_1' })
    expect(await store.get('scope', 'k2')).toEqual({ bookingId: 'bkg_1' })
  })

  it('scopes keys independently — the same key string in two scopes never collides', async () => {
    const store = new FakeIdempotencyStore()
    await store.put('hold_slot', 'k3', { a: 1 })
    await store.put('confirm_with_deposit', 'k3', { a: 2 })
    expect(await store.get('hold_slot', 'k3')).toEqual({ a: 1 })
    expect(await store.get('confirm_with_deposit', 'k3')).toEqual({ a: 2 })
  })

  it('claim on a fresh key returns claimed, and get sees nothing until put', async () => {
    const store = new FakeIdempotencyStore()
    const outcome = await store.claim('scope', 'k4')
    expect(outcome.kind).toBe('claimed')
    expect(await store.get('scope', 'k4')).toBeUndefined() // still pending — the claimant hasn't put yet
  })

  it('a second claim on an already-claimed key waits and then replays the winner\'s put result', async () => {
    const store = new FakeIdempotencyStore()
    await store.claim('scope', 'k5')

    const waiter = store.claim<{ done: true }>('scope', 'k5', { pollIntervalMs: 5, timeoutMs: 1000 })
    await store.put('scope', 'k5', { done: true })

    const outcome = await waiter
    expect(outcome).toEqual({ kind: 'completed', response: { done: true } })
  })

  it('a second claim times out if the winner never puts or releases', async () => {
    const store = new FakeIdempotencyStore()
    await store.claim('scope', 'k6')
    const outcome = await store.claim('scope', 'k6', { pollIntervalMs: 5, timeoutMs: 30 })
    expect(outcome.kind).toBe('timed_out')
  })

  it('release makes a claimed key retryable again', async () => {
    const store = new FakeIdempotencyStore()
    await store.claim('scope', 'k7')
    await store.release('scope', 'k7')
    const outcome = await store.claim('scope', 'k7')
    expect(outcome.kind).toBe('claimed')
  })

  it('deleteExpired removes a stuck pending claim past its own max age, but not a fresh one', async () => {
    const store = new FakeIdempotencyStore()
    await store.claim('scope', 'k8')
    const past = new Date(Date.now() + 10_000)
    const { deletedCount } = await store.deleteExpired(past, { pendingMaxAgeMs: 5_000, completedGraceMs: 60_000 })
    expect(deletedCount).toBe(1)
    expect((await store.claim('scope', 'k8')).kind).toBe('claimed') // proves it's gone, not just still pending
  })

  it('deleteExpired removes a completed row past its grace period, using the completed threshold not the pending one', async () => {
    const store = new FakeIdempotencyStore()
    await store.put('scope', 'k9', { ok: true })
    const past = new Date(Date.now() + 10_000)
    const { deletedCount } = await store.deleteExpired(past, { pendingMaxAgeMs: 60_000, completedGraceMs: 5_000 })
    expect(deletedCount).toBe(1)
    expect(await store.get('scope', 'k9')).toBeUndefined()
  })
})
