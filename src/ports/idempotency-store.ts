/**
 * docs/01-architecture.md §6: every money-moving tool accepts an
 * `idempotency_key`. We store `(key -> response)` and replay the stored
 * response on a repeat, rather than re-executing — a network blip must
 * never produce two deposits against one customer.
 *
 * `scope` namespaces keys per tool (`hold_slot`, `confirm_with_deposit`,
 * ...) so two different tools can never collide on the same key string.
 * Only successful outcomes are stored — see the Slice 1 dev log for why a
 * failed attempt (declined/timeout) is deliberately left retryable.
 */
export interface IdempotencyStore {
  get<T>(scope: string, key: string): Promise<T | undefined>
  put<T>(scope: string, key: string, response: T): Promise<void>

  /**
   * dev-logs/013 (Slice 8): a plain `get`-then-later-`put` is not safe under
   * genuinely *concurrent* retry — two callers with the same key can both
   * miss the cache before either has written it, and both then re-execute
   * the command. For `confirm_with_deposit`/`charge_no_show`/`cancel`, whose
   * status only flips to its terminal value in the transaction *after* the
   * gate check, this let two concurrent identical requests both pass the
   * gate and both append their own copy of the same money events.
   *
   * `claim` closes that window: it atomically reserves `(scope, key)` for
   * exactly one caller. That caller gets `'claimed'` and must, when it's
   * done, call `put` (on success) or `release` (on any failure — the point
   * of the "only store on success" rule above is that a failed attempt stays
   * retryable). Every other concurrent caller gets `'completed'` (replay the
   * winner's result once it lands) or, if the winner never finishes inside
   * `timeoutMs`, `'timed_out'` — the caller should treat that as
   * `IDEMPOTENT_REPLAY` (docs/03-domain-model.md §5).
   */
  claim<T>(scope: string, key: string, options?: ClaimOptions): Promise<ClaimOutcome<T>>

  /** Abandons a claim taken by `claim` without completing it, so the key becomes retryable again. */
  release(scope: string, key: string): Promise<void>
}

export interface ClaimOptions {
  /** How long to wait for a concurrent claimant to finish before giving up. */
  timeoutMs?: number
  pollIntervalMs?: number
}

export type ClaimOutcome<T> =
  | { kind: 'claimed' }
  | { kind: 'completed'; response: T }
  | { kind: 'timed_out' }
