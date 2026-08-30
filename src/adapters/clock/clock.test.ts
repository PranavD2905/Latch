import { describe, expect, it } from 'vitest'
import { FrozenClock } from './frozen-clock.js'
import { SystemClock } from './system-clock.js'

describe('SystemClock', () => {
  it('returns roughly the real current time', () => {
    const clock = new SystemClock()
    const before = Date.now()
    const now = clock.now().getTime()
    const after = Date.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(after)
  })
})

describe('FrozenClock', () => {
  it('stays fixed until advanced', () => {
    const start = new Date('2026-08-27T09:00:00+05:30')
    const clock = new FrozenClock(start)
    expect(clock.now()).toEqual(start)
    expect(clock.now()).toEqual(start) // calling twice does not move it
  })

  it('advances by an exact millisecond offset', () => {
    const start = new Date('2026-08-27T09:00:00.000Z')
    const clock = new FrozenClock(start)
    clock.advance(600_000) // 10 minutes — the hold TTL
    expect(clock.now()).toEqual(new Date('2026-08-27T09:10:00.000Z'))
  })

  it('can be set to an arbitrary instant for boundary testing', () => {
    const clock = new FrozenClock(new Date('2026-08-27T09:00:00.000Z'))
    const boundary = new Date('2026-08-25T09:00:00.000Z') // exactly 48h before a 27th 09:00 appt
    clock.set(boundary)
    expect(clock.now()).toEqual(boundary)
  })
})
