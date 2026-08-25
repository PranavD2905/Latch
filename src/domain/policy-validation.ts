import type { PolicyDraft } from './policy.js'

/**
 * Server-side sanity bounds for the non-money policy fields. Nothing in
 * `docs/03-domain-model.md` pins these numbers down — they're this task's own
 * judgement call, generous enough not to fight a real merchant's use case,
 * tight enough that a fat-fingered `holdTtlSeconds: 3600000` (an hour typed
 * as a millisecond count) can't quietly wreck the demo. Named as constants,
 * not buried, so a reviewer can see exactly what "sane" meant here.
 */
export const POLICY_BOUNDS = {
  holdTtlSeconds: { min: 60, max: 3_600 }, // 1 minute – 1 hour
  noShowGraceMinutes: { min: 0, max: 180 }, // up to 3 hours
  maxConcurrentHoldsPerAgent: { min: 1, max: 50 },
  holdRateLimitPerMinute: { min: 1, max: 1_000 },
  ladderTierCount: { min: 1, max: 20 },
} as const

export const POLICY_VALIDATION_CODES = [
  'AMOUNT_NOT_POSITIVE_INTEGER',
  'HOLD_TTL_OUT_OF_BOUNDS',
  'GRACE_MINUTES_OUT_OF_BOUNDS',
  'MAX_CONCURRENT_HOLDS_OUT_OF_BOUNDS',
  'HOLD_RATE_LIMIT_OUT_OF_BOUNDS',
  'LADDER_EMPTY',
  'LADDER_TOO_MANY_TIERS',
  'LADDER_HOURS_BEFORE_INVALID',
  'LADDER_RETAIN_PCT_OUT_OF_RANGE',
  'LADDER_NOT_STRICTLY_DESCENDING',
  'LADDER_RETAIN_PCT_NOT_MONOTONIC',
  'LADDER_MISSING_FLOOR_TIER',
] as const

export type PolicyValidationCode = (typeof POLICY_VALIDATION_CODES)[number]

/**
 * Thrown by `validatePolicyInput` — a merchant-only, request-validation
 * concern, deliberately kept separate from `Refusal`/`RefusalCode`
 * (`src/domain/refusals.ts`): that vocabulary is "what an *agent* did wrong
 * and what it should do next" (docs/03-domain-model.md §5), and no agent can
 * ever reach `set_policy` at all. This is "what a *merchant* got wrong
 * filling in a form," a different audience with a different next step (fix
 * the field and resubmit).
 */
export class PolicyValidationError extends Error {
  readonly code: PolicyValidationCode

  constructor(code: PolicyValidationCode, message: string) {
    super(message)
    this.name = 'PolicyValidationError'
    this.code = code
  }
}

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0
}

function inBounds(n: number, bounds: { min: number; max: number }): boolean {
  return Number.isInteger(n) && n >= bounds.min && n <= bounds.max
}

/**
 * The gate `set_policy` runs before it ever touches the database — a money
 * rule that fails validation must never partially apply. Every rule here is
 * named in this task's own brief; see each branch's comment for which one.
 */
export function validatePolicyInput(input: PolicyDraft): void {
  // "All amounts positive integer paise."
  if (!isPositiveInteger(input.depositAmountPaise)) {
    throw new PolicyValidationError('AMOUNT_NOT_POSITIVE_INTEGER', `depositAmountPaise must be a positive integer, got ${input.depositAmountPaise}`)
  }
  if (!isPositiveInteger(input.noShowFeePaise)) {
    throw new PolicyValidationError('AMOUNT_NOT_POSITIVE_INTEGER', `noShowFeePaise must be a positive integer, got ${input.noShowFeePaise}`)
  }

  // "holdTtlSeconds, grace, and limits within sane bounds."
  if (!inBounds(input.holdTtlSeconds, POLICY_BOUNDS.holdTtlSeconds)) {
    throw new PolicyValidationError(
      'HOLD_TTL_OUT_OF_BOUNDS',
      `holdTtlSeconds must be an integer between ${POLICY_BOUNDS.holdTtlSeconds.min} and ${POLICY_BOUNDS.holdTtlSeconds.max}, got ${input.holdTtlSeconds}`,
    )
  }
  if (!inBounds(input.noShowGraceMinutes, POLICY_BOUNDS.noShowGraceMinutes)) {
    throw new PolicyValidationError(
      'GRACE_MINUTES_OUT_OF_BOUNDS',
      `noShowGraceMinutes must be an integer between ${POLICY_BOUNDS.noShowGraceMinutes.min} and ${POLICY_BOUNDS.noShowGraceMinutes.max}, got ${input.noShowGraceMinutes}`,
    )
  }
  if (!inBounds(input.maxConcurrentHoldsPerAgent, POLICY_BOUNDS.maxConcurrentHoldsPerAgent)) {
    throw new PolicyValidationError(
      'MAX_CONCURRENT_HOLDS_OUT_OF_BOUNDS',
      `maxConcurrentHoldsPerAgent must be an integer between ${POLICY_BOUNDS.maxConcurrentHoldsPerAgent.min} and ${POLICY_BOUNDS.maxConcurrentHoldsPerAgent.max}, got ${input.maxConcurrentHoldsPerAgent}`,
    )
  }
  if (!inBounds(input.holdRateLimitPerMinute, POLICY_BOUNDS.holdRateLimitPerMinute)) {
    throw new PolicyValidationError(
      'HOLD_RATE_LIMIT_OUT_OF_BOUNDS',
      `holdRateLimitPerMinute must be an integer between ${POLICY_BOUNDS.holdRateLimitPerMinute.min} and ${POLICY_BOUNDS.holdRateLimitPerMinute.max}, got ${input.holdRateLimitPerMinute}`,
    )
  }

  const ladder = input.cancellationLadder
  if (ladder.length === 0) {
    throw new PolicyValidationError('LADDER_EMPTY', 'cancellation ladder must have at least one tier')
  }
  if (ladder.length > POLICY_BOUNDS.ladderTierCount.max) {
    throw new PolicyValidationError('LADDER_TOO_MANY_TIERS', `cancellation ladder must have at most ${POLICY_BOUNDS.ladderTierCount.max} tiers, got ${ladder.length}`)
  }

  for (let i = 0; i < ladder.length; i++) {
    const tier = ladder[i]!
    if (!Number.isInteger(tier.hoursBefore) || tier.hoursBefore < 0) {
      throw new PolicyValidationError('LADDER_HOURS_BEFORE_INVALID', `ladder tier ${i} hoursBefore must be a non-negative integer, got ${tier.hoursBefore}`)
    }
    if (!Number.isInteger(tier.retainPct) || tier.retainPct < 0 || tier.retainPct > 100) {
      throw new PolicyValidationError('LADDER_RETAIN_PCT_OUT_OF_RANGE', `ladder tier ${i} retainPct must be an integer between 0 and 100, got ${tier.retainPct}`)
    }

    if (i > 0) {
      const prev = ladder[i - 1]!
      // "Ladder ordered strictly descending by hoursBefore."
      if (tier.hoursBefore >= prev.hoursBefore) {
        throw new PolicyValidationError(
          'LADDER_NOT_STRICTLY_DESCENDING',
          `ladder tier ${i} (hoursBefore=${tier.hoursBefore}) must be strictly less than the previous tier's hoursBefore (${prev.hoursBefore})`,
        )
      }
      // "retainPct non-decreasing as hoursBefore decreases" — a ladder that
      // gets cheaper closer to the appointment lets a customer game it by
      // waiting.
      if (tier.retainPct < prev.retainPct) {
        throw new PolicyValidationError(
          'LADDER_RETAIN_PCT_NOT_MONOTONIC',
          `ladder tier ${i} (hoursBefore=${tier.hoursBefore}) retains ${tier.retainPct}%, less than the previous, further-out tier's ${prev.retainPct}% — retention must never decrease closer to the appointment`,
        )
      }
    }
  }

  // "Ladder must include a floor tier (hoursBefore: 0)" — the catch-all that
  // makes the ladder total over all of (-infinity, +infinity), per
  // docs/03-domain-model.md §2 and `ladder.ts`'s own doc comment.
  const floorTier = ladder[ladder.length - 1]!
  if (floorTier.hoursBefore !== 0) {
    throw new PolicyValidationError('LADDER_MISSING_FLOOR_TIER', 'the last tier in the ladder must have hoursBefore: 0 — the catch-all floor tier')
  }
}
