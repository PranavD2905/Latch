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
  /**
   * The no-show fee leg is now fully optional — a merchant may run without
   * one at all. Paired, not independently optional: either both are set or
   * neither is, so "a fee with no grace period" or vice versa can't exist.
   * When unset, `confirm_with_deposit` never registers a no-show
   * authorisation and `charge_no_show` refuses with `NO_SHOW_FEE_NOT_CONFIGURED`.
   */
  noShowFeePaise: Paise | undefined
  noShowGraceMinutes: number | undefined
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

/**
 * The raw shape `set_policy` accepts off the wire — every `Policy` field
 * except `policyVersion` (which the server always derives, never takes from
 * a caller), with un-branded `number` amounts because this is exactly what
 * `validatePolicyInput` must check *before* anything is safe to brand as
 * `Paise` (a negative or fractional amount is a validation error, not a
 * `toPaise` throw a merchant never sees a clean code for).
 */
export interface PolicyDraft {
  depositAmountPaise: number
  cancellationLadder: readonly LadderTier[]
  /** Both present or both absent — see `Policy.noShowFeePaise`'s doc comment. */
  noShowFeePaise: number | undefined
  noShowGraceMinutes: number | undefined
  holdTtlSeconds: number
  maxConcurrentHoldsPerAgent: number
  holdRateLimitPerMinute: number
}

/**
 * A `PolicyDraft` that has passed `validatePolicyInput` and had its amounts
 * branded — what `CatalogRepo.publishPolicy` actually accepts.
 * `docs/03-domain-model.md` §2: publishing is an INSERT of a new version,
 * never an UPDATE of an existing one.
 */
export type PolicyInput = Omit<PolicyDraft, 'depositAmountPaise' | 'noShowFeePaise'> & {
  depositAmountPaise: Paise
  noShowFeePaise: Paise | undefined
}
