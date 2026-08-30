import { describe, expect, it } from 'vitest'
import { computeSlots, type WorkingHours } from './slots.js'

// Thursday 2026-09-03 is a Thursday in IST.
const THURSDAY_WORKING_HOURS: WorkingHours = {
  thu: [
    ['09:00', '10:00'],
    ['14:00', '15:00'],
  ],
}

describe('computeSlots', () => {
  it('generates back-to-back slots across a single working window', () => {
    const from = new Date('2026-09-01T00:00:00+05:30') // Tuesday, well before Thursday
    const slots = computeSlots({
      workingHours: THURSDAY_WORKING_HOURS,
      serviceDurationMinutes: 30,
      busyIntervals: [],
      from,
      days: 7,
    })

    // 09:00-10:00 window / 30-min service -> two slots; 14:00-15:00 -> two more.
    const morningSlots = slots.filter((s) => s.getTime() === new Date('2026-09-03T09:00:00+05:30').getTime() || s.getTime() === new Date('2026-09-03T09:30:00+05:30').getTime())
    expect(morningSlots).toHaveLength(2)

    const afternoonSlots = slots.filter((s) => s.getTime() === new Date('2026-09-03T14:00:00+05:30').getTime() || s.getTime() === new Date('2026-09-03T14:30:00+05:30').getTime())
    expect(afternoonSlots).toHaveLength(2)
  })

  it('excludes a slot that overlaps an existing live booking', () => {
    const from = new Date('2026-09-01T00:00:00+05:30')
    const busyIntervals = [{ startsAt: new Date('2026-09-03T09:00:00+05:30'), endsAt: new Date('2026-09-03T09:30:00+05:30') }]
    const slots = computeSlots({
      workingHours: THURSDAY_WORKING_HOURS,
      serviceDurationMinutes: 30,
      busyIntervals,
      from,
      days: 7,
    })

    expect(slots.some((s) => s.getTime() === new Date('2026-09-03T09:00:00+05:30').getTime())).toBe(false)
    // The next slot in the same window is unaffected.
    expect(slots.some((s) => s.getTime() === new Date('2026-09-03T09:30:00+05:30').getTime())).toBe(true)
  })

  it('excludes slots already in the past relative to `from`', () => {
    // "now" is 09:15 Thursday — the 09:00 slot has already started.
    const from = new Date('2026-09-03T09:15:00+05:30')
    const slots = computeSlots({
      workingHours: THURSDAY_WORKING_HOURS,
      serviceDurationMinutes: 30,
      busyIntervals: [],
      from,
      days: 1,
    })

    expect(slots.some((s) => s.getTime() === new Date('2026-09-03T09:00:00+05:30').getTime())).toBe(false)
  })

  it('returns nothing for a day with no working-hours entry', () => {
    const from = new Date('2026-09-01T00:00:00+05:30') // Tuesday, not in the working-hours map
    const slots = computeSlots({
      workingHours: THURSDAY_WORKING_HOURS,
      serviceDurationMinutes: 30,
      busyIntervals: [],
      from,
      days: 1,
    })
    expect(slots).toHaveLength(0)
  })

  it('does not generate a slot that would run past the end of the window', () => {
    // A 45-min service cannot fit twice into a 60-min window with a 30-min step from 09:00.
    const from = new Date('2026-09-01T00:00:00+05:30')
    const slots = computeSlots({
      workingHours: THURSDAY_WORKING_HOURS,
      serviceDurationMinutes: 45,
      busyIntervals: [],
      from,
      days: 7,
    })
    const morningSlots = slots.filter((s) => s < new Date('2026-09-03T12:00:00+05:30'))
    expect(morningSlots).toEqual([new Date('2026-09-03T09:00:00+05:30')])
  })
})
