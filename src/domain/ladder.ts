import type { LadderTier } from './policy.js'

export interface LadderResult {
  tier: LadderTier
  retainPct: number
  hoursUntil: number
}

export class InvalidLadderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidLadderError'
  }
}

/**
 * The only genuinely subtle piece of logic in the system.
 * docs/03-domain-model.md §2:
 *
 *   hoursUntil = (appointmentStart - now) / 3_600_000
 *   return the FIRST tier (descending hours_before) where hoursUntil >= tier.hours_before
 *
 * Boundaries are inclusive on the upper side — at exactly the threshold, the
 * customer gets the *better* (lower-retention) tier. Ambiguity in a penalty
 * schedule resolves in favour of the person being penalised.
 *
 * **Docs correction made in Slice 1** (see dev-logs/004): the literal algorithm
 * above does not handle an already-started or past-dated appointment. With the
 * worked-example ladder (48/12/0), hoursUntil = -2.0 fails `-2 >= 0`, so no
 * tier matches under a strict reading — yet §2's own worked-example table
 * lists hoursUntil = -2.0 as matching the `hours_before: 0` tier at 100%
 * retention. The fix, applied here: the *last* tier in descending order (the
 * smallest hoursBefore — by convention 0, "the floor") is a catch-all. It
 * matches not just when hoursUntil >= its threshold, but for anything below
 * it too, since there is no lower tier left to hand the case to. This is
 * the only sensible reading — the ladder must be total over all of
 * (-infinity, +infinity), not just [0, +infinity) — and it reproduces every
 * row of the worked-example table exactly, including the negative one.
 */
export function evaluateLadder(ladder: readonly LadderTier[], appointmentStart: Date, now: Date): LadderResult {
  if (ladder.length === 0) {
    throw new InvalidLadderError('cancellation ladder must have at least one tier')
  }

  const sorted = [...ladder].sort((a, b) => b.hoursBefore - a.hoursBefore)
  const hoursUntil = (appointmentStart.getTime() - now.getTime()) / 3_600_000

  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i]!
    const isLastTier = i === sorted.length - 1
    if (hoursUntil >= tier.hoursBefore || isLastTier) {
      return { tier, retainPct: tier.retainPct, hoursUntil }
    }
  }

  // Unreachable: the loop above always returns on its last iteration.
  throw new InvalidLadderError('unreachable')
}
