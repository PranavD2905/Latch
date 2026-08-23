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
}
