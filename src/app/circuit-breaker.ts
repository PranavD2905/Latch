import type { Clock } from '../ports/clock.js'

/**
 * dev-logs/016 (this session's SDE3-review follow-up): the reconciliation
 * worker (`reconciliation-worker.ts`) makes a real Razorpay call per open
 * booking, every tick. If Razorpay itself is down or badly degraded, a naive
 * worker retries every candidate, every 60 seconds, forever — hammering an
 * already-struggling upstream with load that cannot possibly succeed, and
 * doing it from every replica the advisory lock in `advisory-lock.ts` lets
 * run (that lock stops N replicas from *duplicating* one tick's work, it
 * never stops a single tick from making a doomed call).
 *
 * A small three-state breaker, in-memory, one per process — matching this
 * project's existing bias (docs/02-tech-stack.md §9/§15) against a new
 * datastore for something this low-frequency. It does not need to survive a
 * restart: a fresh process re-learns "Razorpay is down" on its very next
 * failed call, at most one tick slower than a persisted breaker would be.
 *
 * - **closed** — calls go through. `failureThreshold` consecutive failures
 *   opens it.
 * - **open** — calls are rejected locally, with no network attempt, until
 *   `cooldownMs` has passed.
 * - **half-open** — the first call after cooldown is allowed through as a
 *   probe. Success closes the breaker; failure reopens it (and restarts the
 *   cooldown) rather than immediately hammering again.
 *
 * Takes a `Clock`, not `Date.now()`, for the same reason every other
 * timing-sensitive thing in this codebase does (docs/01-architecture.md §5)
 * — `circuit-breaker.test.ts` drives the open→cooldown→half-open→closed
 * cycle with a `FrozenClock`, deterministically, rather than a real sleep.
 */
export class CircuitOpenError extends Error {
  constructor(public readonly breakerName: string) {
    super(`circuit "${breakerName}" is open — refusing to call a provider that has failed repeatedly`)
    this.name = 'CircuitOpenError'
  }
}

export interface CircuitBreakerOptions {
  name: string
  clock: Clock
  /** Consecutive failures (from closed, or one failed half-open probe) before the circuit opens. */
  failureThreshold: number
  /** How long the circuit stays open before allowing one half-open probe call. */
  cooldownMs: number
}

type State = 'closed' | 'open' | 'half_open'

export class CircuitBreaker {
  private state: State = 'closed'
  private consecutiveFailures = 0
  private openedAt: Date | undefined

  constructor(private readonly opts: CircuitBreakerOptions) {}

  /** For logging/observability only — never branch app logic on this directly, call `execute`. */
  get currentState(): State {
    this.maybeTransitionToHalfOpen()
    return this.state
  }

  /**
   * `isFailure` (default: every rejection counts) lets a caller exclude
   * *expected* outcomes from the failure streak — dev-logs/020: wrapping a
   * money-moving call (`captureDeposit`/`authorize`/`captureAuthorization`/
   * `refundDeposit`) means an ordinary customer decline or a
   * `CaptureAmountMismatchError` gate refusal would otherwise count the same
   * as Razorpay itself being down, tripping the breaker on business-as-usual
   * traffic. `reconciliation.ts`'s existing calls never pass this — every
   * error `fetchPaymentStatus`/`fetchAuthorizationStatus` can throw already
   * means "the provider call itself failed," so the default is correct
   * there unchanged.
   */
  async execute<T>(fn: () => Promise<T>, options?: { isFailure?: (err: unknown) => boolean }): Promise<T> {
    this.maybeTransitionToHalfOpen()
    if (this.state === 'open') {
      throw new CircuitOpenError(this.opts.name)
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      if (options?.isFailure?.(err) ?? true) {
        this.onFailure()
      }
      throw err
    }
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state !== 'open' || !this.openedAt) return
    const elapsedMs = this.opts.clock.now().getTime() - this.openedAt.getTime()
    if (elapsedMs >= this.opts.cooldownMs) {
      this.state = 'half_open'
    }
  }

  private onSuccess(): void {
    this.state = 'closed'
    this.consecutiveFailures = 0
    this.openedAt = undefined
  }

  private onFailure(): void {
    this.consecutiveFailures += 1
    // A failed half-open probe reopens immediately, regardless of
    // `failureThreshold` — one probe is the whole point of half-open, not
    // another `failureThreshold`-sized batch of real calls against a
    // provider that just proved it's still down.
    if (this.state === 'half_open' || this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = 'open'
      this.openedAt = this.opts.clock.now()
    }
  }
}
