import type { AppDeps } from './types.js'

export interface IdempotencyCleanupWorkerResult {
  deletedCount: number
}

/**
 * A **completed** row older than this is safe to forget — nobody retries a
 * request from a week ago expecting a replay; a genuinely-late retry that
 * arrives after this window re-executes instead, the same behaviour this
 * store had before idempotency protection existed for that exact key.
 */
const COMPLETED_GRACE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A **pending** row older than this means its claimant crashed before ever
 * calling `put`/`release` (`IdempotencyStore.claim`'s own doc comment names
 * this gap: nothing else can call `release` on someone else's claim, so a
 * process death mid-command leaves the key permanently stuck otherwise).
 * Must stay well above the longest legitimate claim duration anywhere this
 * store is used — `confirm_with_deposit`'s own `IDEMPOTENCY_CLAIM_TIMEOUT_MS`
 * (5 minutes) is the longest in this codebase today. 1 hour leaves better than a 10x
 * margin — deleting a row a still-live claimant owns would let a second
 * caller re-claim the same key and run concurrently with the first,
 * reopening dev-logs/013's race.
 */
const PENDING_MAX_AGE_MS = 60 * 60 * 1000

/**
 * dev-logs/021. Same shape as the other periodic workers (`hold-expiry-
 * worker.ts`, `no-show-eligibility-worker.ts`): one function, called from
 * the same background tick every process already runs
 * (`mcp/http.ts`/`worker/background.ts`), no separate interval of its own.
 * Cheap even when there's nothing to delete — `deleteExpired`'s two
 * `DELETE`s are indexed (migration 0014) and return zero rows on a normal
 * tick.
 */
export async function runIdempotencyCleanupWorker(deps: AppDeps): Promise<IdempotencyCleanupWorkerResult> {
  const { deletedCount } = await deps.idempotencyStore.deleteExpired(deps.clock.now(), {
    pendingMaxAgeMs: PENDING_MAX_AGE_MS,
    completedGraceMs: COMPLETED_GRACE_MS,
  })
  return { deletedCount }
}
