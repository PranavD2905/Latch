/**
 * Mirrors `src/domain/policy.ts` — hand-kept in sync, same convention
 * `types.ts` already uses for `BookingEvent` (no shared build boundary
 * between the server and this Vite app).
 */

export interface LadderTier {
  hoursBefore: number
  retainPct: number
}

export interface Policy {
  policyVersion: number
  depositAmountPaise: number
  cancellationLadder: readonly LadderTier[]
  /** Optional now — both present or both absent. A merchant can run with no no-show fee at all. */
  noShowFeePaise: number | undefined
  noShowGraceMinutes: number | undefined
  holdTtlSeconds: number
  maxConcurrentHoldsPerAgent: number
  holdRateLimitPerMinute: number
}

/** Mirrors `src/app/set-policy.ts`'s `SetPolicyCommand` — no version field, ever. */
export interface PolicyDraft {
  depositAmountPaise: number
  cancellationLadder: readonly LadderTier[]
  noShowFeePaise: number | undefined
  noShowGraceMinutes: number | undefined
  holdTtlSeconds: number
  maxConcurrentHoldsPerAgent: number
  holdRateLimitPerMinute: number
}

export function draftFromPolicy(policy: Policy): PolicyDraft {
  return {
    depositAmountPaise: policy.depositAmountPaise,
    cancellationLadder: policy.cancellationLadder.map((t) => ({ ...t })),
    noShowFeePaise: policy.noShowFeePaise,
    noShowGraceMinutes: policy.noShowGraceMinutes,
    holdTtlSeconds: policy.holdTtlSeconds,
    maxConcurrentHoldsPerAgent: policy.maxConcurrentHoldsPerAgent,
    holdRateLimitPerMinute: policy.holdRateLimitPerMinute,
  }
}

/** A service the merchant offers — mirrors `src/ports/catalog-repo.ts`'s `ServiceRecord`. */
export interface Service {
  serviceId: string
  name: string
  durationMinutes: number
  pricePaise: number
}

/**
 * Mirrors `src/domain/policy-validation.ts`'s rules — client-side only, for
 * immediate form feedback. The server re-runs the authoritative version of
 * every one of these on publish; this exists so a merchant sees a mistake
 * before clicking Publish, not instead of the server check.
 */
export function validateDraft(draft: PolicyDraft): string | undefined {
  if (!Number.isInteger(draft.depositAmountPaise) || draft.depositAmountPaise <= 0) return 'Deposit must be a positive whole number of paise.'

  // Both present or both absent — see Policy.noShowFeePaise's own doc comment.
  const noShowFeeSet = draft.noShowFeePaise !== undefined
  const noShowGraceSet = draft.noShowGraceMinutes !== undefined
  if (noShowFeeSet !== noShowGraceSet) return 'No-show fee and grace period must be set together, or both left off to run without a no-show fee.'
  if (noShowFeeSet && (!Number.isInteger(draft.noShowFeePaise) || draft.noShowFeePaise! <= 0)) return 'No-show fee must be a positive whole number of paise.'
  if (noShowGraceSet && (!Number.isInteger(draft.noShowGraceMinutes) || draft.noShowGraceMinutes! < 0 || draft.noShowGraceMinutes! > 180))
    return 'Grace period must be an integer between 0 and 180 minutes.'

  if (!Number.isInteger(draft.holdTtlSeconds) || draft.holdTtlSeconds < 60 || draft.holdTtlSeconds > 3_600) return 'Hold TTL must be an integer between 60 and 3600 seconds.'
  if (!Number.isInteger(draft.maxConcurrentHoldsPerAgent) || draft.maxConcurrentHoldsPerAgent < 1 || draft.maxConcurrentHoldsPerAgent > 50)
    return 'Max concurrent holds must be an integer between 1 and 50.'
  if (!Number.isInteger(draft.holdRateLimitPerMinute) || draft.holdRateLimitPerMinute < 1 || draft.holdRateLimitPerMinute > 1_000)
    return 'Hold rate limit must be an integer between 1 and 1000.'

  const ladder = draft.cancellationLadder
  if (ladder.length === 0) return 'The cancellation ladder needs at least one tier.'
  for (let i = 0; i < ladder.length; i++) {
    const tier = ladder[i]!
    if (!Number.isInteger(tier.hoursBefore) || tier.hoursBefore < 0) return `Tier ${i + 1}: hours-before must be a non-negative whole number.`
    if (!Number.isInteger(tier.retainPct) || tier.retainPct < 0 || tier.retainPct > 100) return `Tier ${i + 1}: retained % must be an integer between 0 and 100.`
    if (i > 0) {
      const prev = ladder[i - 1]!
      if (tier.hoursBefore >= prev.hoursBefore) return `Tier ${i + 1}: hours-before must be strictly less than the tier above it.`
      if (tier.retainPct < prev.retainPct) return `Tier ${i + 1}: retained % cannot be lower than the tier above it — retention must not decrease closer to the appointment.`
    }
  }
  if (ladder[ladder.length - 1]!.hoursBefore !== 0) return 'The last tier must have hours-before = 0 — the floor tier that covers right up to (and past) the appointment time.'

  return undefined
}
