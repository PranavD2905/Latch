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
 * The versioned policy — deposit rule and cancellation ladder. docs/03-
 * domain-model.md §2. This is the authority every money action cites.
 *
 * No no-show fee field (removed — see the dev log for that removal): a
 * post-hoc debit against a stored card is not how Indian merchants recover a
 * no-show. The cancellation ladder's own `hoursBefore: 0` floor tier — full
 * deposit forfeiture — already is that recovery mechanism, and needed no new
 * field to express it.
 */
export interface Policy {
  policyVersion: number
  /**
   * Fully optional — a merchant may run with no upfront deposit at all
   * (payment-link feature follow-up: "if no deposit is set, it should not
   * show the deposit link"). `undefined` simply means `confirm_with_deposit`
   * never creates a deposit order or captures anything for that leg.
   */
  depositAmountPaise: Paise | undefined
  cancellationLadder: readonly LadderTier[]
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
  depositAmountPaise: number | undefined
  cancellationLadder: readonly LadderTier[]
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
export type PolicyInput = Omit<PolicyDraft, 'depositAmountPaise'> & {
  depositAmountPaise: Paise | undefined
}
