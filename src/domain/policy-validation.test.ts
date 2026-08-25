import { describe, expect, it } from 'vitest'
import type { PolicyDraft } from './policy.js'
import { PolicyValidationError, validatePolicyInput } from './policy-validation.js'

/** A known-good policy — every test starts here and breaks exactly one thing. */
function validInput(overrides: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    depositAmountPaise: 30_000,
    cancellationLadder: [
      { hoursBefore: 48, retainPct: 0 },
      { hoursBefore: 12, retainPct: 50 },
      { hoursBefore: 0, retainPct: 100 },
    ],
    noShowFeePaise: 40_000,
    noShowGraceMinutes: 15,
    holdTtlSeconds: 600,
    maxConcurrentHoldsPerAgent: 3,
    holdRateLimitPerMinute: 10,
    ...overrides,
  }
}

function codeOf(fn: () => void): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof PolicyValidationError) return err.code
    throw err
  }
  throw new Error('expected validatePolicyInput to throw, but it did not')
}

describe('validatePolicyInput', () => {
  it('accepts the known-good policy unchanged', () => {
    expect(() => validatePolicyInput(validInput())).not.toThrow()
  })

  describe('amounts must be positive integer paise', () => {
    it('rejects a zero deposit', () => {
      expect(codeOf(() => validatePolicyInput(validInput({ depositAmountPaise: 0 })))).toBe('AMOUNT_NOT_POSITIVE_INTEGER')
    })
    it('rejects a negative deposit', () => {
      expect(codeOf(() => validatePolicyInput(validInput({ depositAmountPaise: -100 })))).toBe('AMOUNT_NOT_POSITIVE_INTEGER')
    })
    it('rejects a fractional deposit (rupees, not paise)', () => {
      expect(codeOf(() => validatePolicyInput(validInput({ depositAmountPaise: 300.5 })))).toBe('AMOUNT_NOT_POSITIVE_INTEGER')
    })
    it('rejects a zero no-show fee', () => {
      expect(codeOf(() => validatePolicyInput(validInput({ noShowFeePaise: 0 })))).toBe('AMOUNT_NOT_POSITIVE_INTEGER')
    })
  })

  describe('sane bounds on TTL, grace, and limits', () => {
    it('rejects a hold TTL below the floor', () => {
      expect(codeOf(() => validatePolicyInput(validInput({ holdTtlSeconds: 10 })))).toBe('HOLD_TTL_OUT_OF_BOUNDS')
    })
    it('rejects a hold TTL above the ceiling (e.g. milliseconds typed as seconds)', () => {
      expect(codeOf(() => validatePolicyInput(validInput({ holdTtlSeconds: 3_600_000 })))).toBe('HOLD_TTL_OUT_OF_BOUNDS')
    })
    it('rejects a negative grace period', () => {
      expect(codeOf(() => validatePolicyInput(validInput({ noShowGraceMinutes: -5 })))).toBe('GRACE_MINUTES_OUT_OF_BOUNDS')
    })
    it('rejects an unbounded max-concurrent-holds', () => {
      expect(codeOf(() => validatePolicyInput(validInput({ maxConcurrentHoldsPerAgent: 0 })))).toBe('MAX_CONCURRENT_HOLDS_OUT_OF_BOUNDS')
    })
    it('rejects an absurd hold-rate limit', () => {
      expect(codeOf(() => validatePolicyInput(validInput({ holdRateLimitPerMinute: 100_000 })))).toBe('HOLD_RATE_LIMIT_OUT_OF_BOUNDS')
    })
  })

  describe('the cancellation ladder', () => {
    it('rejects an empty ladder', () => {
      expect(codeOf(() => validatePolicyInput(validInput({ cancellationLadder: [] })))).toBe('LADDER_EMPTY')
    })

    it('rejects a ladder not ordered strictly descending by hoursBefore', () => {
      const ladder = [
        { hoursBefore: 12, retainPct: 50 },
        { hoursBefore: 48, retainPct: 0 },
        { hoursBefore: 0, retainPct: 100 },
      ]
      expect(codeOf(() => validatePolicyInput(validInput({ cancellationLadder: ladder })))).toBe('LADDER_NOT_STRICTLY_DESCENDING')
    })

    it('rejects two tiers tied on the same hoursBefore', () => {
      const ladder = [
        { hoursBefore: 48, retainPct: 0 },
        { hoursBefore: 48, retainPct: 50 },
        { hoursBefore: 0, retainPct: 100 },
      ]
      expect(codeOf(() => validatePolicyInput(validInput({ cancellationLadder: ladder })))).toBe('LADDER_NOT_STRICTLY_DESCENDING')
    })

    it('rejects a retainPct outside 0-100', () => {
      const ladder = [
        { hoursBefore: 48, retainPct: -10 },
        { hoursBefore: 0, retainPct: 100 },
      ]
      expect(codeOf(() => validatePolicyInput(validInput({ cancellationLadder: ladder })))).toBe('LADDER_RETAIN_PCT_OUT_OF_RANGE')
    })

    it('rejects a retainPct above 100', () => {
      const ladder = [
        { hoursBefore: 48, retainPct: 0 },
        { hoursBefore: 0, retainPct: 150 },
      ]
      expect(codeOf(() => validatePolicyInput(validInput({ cancellationLadder: ladder })))).toBe('LADDER_RETAIN_PCT_OUT_OF_RANGE')
    })

    it('rejects retention that decreases closer to the appointment — the ladder-gaming case', () => {
      // A customer waiting from >48h out to inside 12h would see the
      // penalty drop from 50% to 20% — exactly the dodge this rule exists
      // to close.
      const ladder = [
        { hoursBefore: 48, retainPct: 50 },
        { hoursBefore: 12, retainPct: 20 },
        { hoursBefore: 0, retainPct: 100 },
      ]
      expect(codeOf(() => validatePolicyInput(validInput({ cancellationLadder: ladder })))).toBe('LADDER_RETAIN_PCT_NOT_MONOTONIC')
    })

    it('accepts retention that stays flat between tiers (non-decreasing allows equal)', () => {
      const ladder = [
        { hoursBefore: 48, retainPct: 50 },
        { hoursBefore: 12, retainPct: 50 },
        { hoursBefore: 0, retainPct: 100 },
      ]
      expect(() => validatePolicyInput(validInput({ cancellationLadder: ladder }))).not.toThrow()
    })

    it('rejects a ladder missing the hoursBefore: 0 floor tier', () => {
      const ladder = [
        { hoursBefore: 48, retainPct: 0 },
        { hoursBefore: 12, retainPct: 50 },
      ]
      expect(codeOf(() => validatePolicyInput(validInput({ cancellationLadder: ladder })))).toBe('LADDER_MISSING_FLOOR_TIER')
    })

    it('rejects a negative hoursBefore', () => {
      const ladder = [
        { hoursBefore: 48, retainPct: 0 },
        { hoursBefore: -1, retainPct: 100 },
      ]
      expect(codeOf(() => validatePolicyInput(validInput({ cancellationLadder: ladder })))).toBe('LADDER_HOURS_BEFORE_INVALID')
    })

    it('accepts a single-tier ladder that is itself the floor', () => {
      expect(() => validatePolicyInput(validInput({ cancellationLadder: [{ hoursBefore: 0, retainPct: 100 }] }))).not.toThrow()
    })
  })
})
