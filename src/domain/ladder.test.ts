import { describe, expect, it } from 'vitest'
import { evaluateLadder, InvalidLadderError } from './ladder.js'
import { addPaise, floorPercentageOf, subtractPaise, toPaise } from './money.js'
import type { LadderTier } from './policy.js'

// The example ladder from docs/03-domain-model.md §2.
const LADDER: readonly LadderTier[] = [
  { hoursBefore: 48, retainPct: 0 },
  { hoursBefore: 12, retainPct: 50 },
  { hoursBefore: 0, retainPct: 100 },
]

const APPOINTMENT = new Date('2026-09-03T16:00:00+05:30')

function hoursBefore(h: number): Date {
  return new Date(APPOINTMENT.getTime() - h * 3_600_000)
}

describe('evaluateLadder — boundary tests on a frozen clock (docs/03-domain-model.md §2 worked examples)', () => {
  it('72h before: matches the 48h tier, 0% retained', () => {
    const result = evaluateLadder(LADDER, APPOINTMENT, hoursBefore(72))
    expect(result.tier.hoursBefore).toBe(48)
    expect(result.retainPct).toBe(0)
  })

  it('exactly 48h before: inclusive upper boundary — still the 48h tier, 0% retained', () => {
    const result = evaluateLadder(LADDER, APPOINTMENT, hoursBefore(48))
    expect(result.tier.hoursBefore).toBe(48)
    expect(result.retainPct).toBe(0)
  })

  it('47h59m before: one minute past the boundary — drops to the 12h tier, 50% retained', () => {
    const result = evaluateLadder(LADDER, APPOINTMENT, hoursBefore(47 + 59 / 60))
    expect(result.tier.hoursBefore).toBe(12)
    expect(result.retainPct).toBe(50)
  })

  it('exactly 12h before: inclusive upper boundary — still the 12h tier, 50% retained', () => {
    const result = evaluateLadder(LADDER, APPOINTMENT, hoursBefore(12))
    expect(result.tier.hoursBefore).toBe(12)
    expect(result.retainPct).toBe(50)
  })

  it('11h59m before: one minute past the boundary — drops to the 0h tier, 100% retained', () => {
    const result = evaluateLadder(LADDER, APPOINTMENT, hoursBefore(11 + 59 / 60))
    expect(result.tier.hoursBefore).toBe(0)
    expect(result.retainPct).toBe(100)
  })

  it('a past-dated appointment (already started): the 0h tier is a catch-all, 100% retained', () => {
    // hoursUntil is negative here. This is the case the literal doc algorithm
    // got wrong — see the comment in ladder.ts and dev-logs/004.
    const now = new Date(APPOINTMENT.getTime() + 2 * 3_600_000) // 2h after start
    const result = evaluateLadder(LADDER, APPOINTMENT, now)
    expect(result.tier.hoursBefore).toBe(0)
    expect(result.retainPct).toBe(100)
    expect(result.hoursUntil).toBeCloseTo(-2, 5)
  })

  it('rejects an empty ladder', () => {
    expect(() => evaluateLadder([], APPOINTMENT, hoursBefore(72))).toThrow(InvalidLadderError)
  })

  it('is indifferent to the input ordering of tiers', () => {
    const shuffled = [LADDER[2]!, LADDER[0]!, LADDER[1]!]
    const result = evaluateLadder(shuffled, APPOINTMENT, hoursBefore(20))
    expect(result.tier.hoursBefore).toBe(12)
  })
})

describe('rounding — retain + refund always sum exactly to the deposit', () => {
  it('50% of an odd-paise deposit: floors the retained half, refund is the exact remainder', () => {
    // 799 paise * 50% = 399.5 -> must floor to 399, never round to 400.
    const deposit = toPaise(799)
    const { retainPct } = evaluateLadder(LADDER, APPOINTMENT, hoursBefore(20))
    expect(retainPct).toBe(50)

    const retained = floorPercentageOf(deposit, retainPct)
    const refunded = subtractPaise(deposit, retained)

    expect(retained).toBe(399)
    expect(refunded).toBe(400)
    expect(addPaise(retained, refunded)).toBe(deposit)
  })

  it('holds for every odd deposit amount from 1 to 999 paise at 50%', () => {
    for (let amount = 1; amount <= 999; amount++) {
      const deposit = toPaise(amount)
      const retained = floorPercentageOf(deposit, 50)
      const refunded = subtractPaise(deposit, retained)
      expect(addPaise(retained, refunded)).toBe(deposit)
    }
  })
})
