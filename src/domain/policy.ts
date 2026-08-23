import type { Paise } from './money.js'

/**
 * One rung of the cancellation ladder. docs/03-domain-model.md §2.
 * The ladder array is ordered descending by hoursBefore, and by construction
 * always ends in a `hoursBefore: 0` catch-all tier — see ladder.ts for why
 * that matters for already-started / past-dated appointments.
 */
export interface LadderTier {
  hoursBefore: number
  retainPct: number
}

/**
 * The versioned policy — deposit rule, cancellation ladder, no-show terms.
 * docs/03-domain-model.md §2. This is the authority every money action cites.
 */
export interface Policy {
  policyVersion: number
  depositAmountPaise: Paise
  cancellationLadder: readonly LadderTier[]
  noShowFeePaise: Paise
  noShowGraceMinutes: number
  holdTtlSeconds: number
  maxConcurrentHoldsPerAgent: number
}
