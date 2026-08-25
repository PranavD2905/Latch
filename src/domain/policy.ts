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
  /**
   * dev-logs/014, gap 2: `maxConcurrentHoldsPerAgent` bounds how many holds
   * an agent can have *live* at once, but says nothing about the *rate* at
   * which it can re-hold as TTLs lapse — a hostile agent can sit at the
   * ceiling indefinitely, releasing/re-holding, and lock out legitimate
   * agents with zero money movement and therefore zero payment trail. This
   * is the request-rate ceiling that closes that gap: the maximum number of
   * `hold_slot` successes one agent may accumulate in a rolling 60-second
   * window, checked inside the same `lockAgent` transaction as the
   * concurrent-hold check. Named, not just documented — docs/04-features-
   * and-limitations.md.
   */
  holdRateLimitPerMinute: number
}
