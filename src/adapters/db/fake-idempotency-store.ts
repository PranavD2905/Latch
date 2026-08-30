import type { ClaimOptions, ClaimOutcome, IdempotencyStore } from '../../ports/idempotency-store.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 10

/** Mirrors `PostgresIdempotencyStore`'s own sentinel exactly (dev-logs/013) — never a shape a real command result could produce. */
const PENDING_MARKER = { __idempotencyPending: true } as const

function isPending(response: unknown): boolean {
  return typeof response === 'object' && response !== null && (response as Record<string, unknown>)['__idempotencyPending'] === true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Row {
  response: unknown
  createdAt: Date
}

/**
 * `IdempotencyStore`'s in-memory test double — same role as `FakePaymentProvider`/
 * `FakePaymentRail` (docs/02-tech-stack.md §13), but for a port that had no
 * fake at all before this: every `claim`/`get`/`put`/`release` path a
 * command handler exercises (successful replay, concurrent-claim wait,
 * `IDEMPOTENT_REPLAY` on timeout, a released claim becoming retryable again)
 * used to be reachable only through a real Postgres-backed integration test.
 * This reimplements `PostgresIdempotencyStore`'s exact claim/pending-marker
 * discipline (dev-logs/013) against a plain `Map`, so the same assertions
 * run as a fast unit test — see `fake-idempotency-store.test.ts`.
 *
 * Deliberately not a replacement for the real thing anywhere concurrency
 * *itself* is under test: two callers racing a single `claim` here still
 * race over one JS event loop, never two real Postgres connections, so this
 * is the right tool for "does the claim/replay/timeout logic behave
 * correctly," not for "is the underlying atomic reservation actually
 * atomic under real concurrent connections" — `concurrency-idempotency.integration.test.ts`
 * keeps doing that job, against the real store.
 */
export class FakeIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, Row>()

  private key(scope: string, key: string): string {
    return `${scope} ${key}`
  }

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    const row = this.rows.get(this.key(scope, key))
    if (!row || isPending(row.response)) {
      return undefined
    }
    return row.response as T
  }

  async put<T>(scope: string, key: string, response: T): Promise<void> {
    this.rows.set(this.key(scope, key), { response, createdAt: new Date() })
  }

  async release(scope: string, key: string): Promise<void> {
    this.rows.delete(this.key(scope, key))
  }

  async claim<T>(scope: string, key: string, options?: ClaimOptions): Promise<ClaimOutcome<T>> {
    const mapKey = this.key(scope, key)
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const deadline = Date.now() + timeoutMs

    const existing = this.rows.get(mapKey)
    if (!existing) {
      this.rows.set(mapKey, { response: PENDING_MARKER, createdAt: new Date() })
      return { kind: 'claimed' }
    }
    if (!isPending(existing.response)) {
      return { kind: 'completed', response: existing.response as T }
    }

    // A pending claim already exists (this store's single-process test
    // caller took it, hasn't `put`/`release`d yet) — poll the same way
    // `PostgresIdempotencyStore` does, for the same reason: a concurrent
    // twin's `put` can land at any point, and there is no in-memory
    // equivalent of blocking on another connection's row lock.
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs)
      const row = this.rows.get(mapKey)
      if (!row) {
        this.rows.set(mapKey, { response: PENDING_MARKER, createdAt: new Date() })
        return { kind: 'claimed' }
      }
      if (!isPending(row.response)) {
        return { kind: 'completed', response: row.response as T }
      }
    }
    return { kind: 'timed_out' }
  }

  async deleteExpired(now: Date, options: { pendingMaxAgeMs: number; completedGraceMs: number }): Promise<{ deletedCount: number }> {
    let deletedCount = 0
    for (const [mapKey, row] of this.rows) {
      const maxAgeMs = isPending(row.response) ? options.pendingMaxAgeMs : options.completedGraceMs
      if (now.getTime() - row.createdAt.getTime() > maxAgeMs) {
        this.rows.delete(mapKey)
        deletedCount++
      }
    }
    return { deletedCount }
  }
}
