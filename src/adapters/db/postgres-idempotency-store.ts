import { and, eq } from 'drizzle-orm'
import type { ClaimOptions, ClaimOutcome, IdempotencyStore } from '../../ports/idempotency-store.js'
import type { Db } from './client.js'
import { idempotencyKeys } from './schema.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 50

/**
 * Written by `claim` in place of a real response while a claimant is still
 * doing the work — never a shape any real command result could produce
 * (every real result is a plain data object with no field named this).
 * dev-logs/013.
 */
const PENDING_MARKER = { __idempotencyPending: true } as const

function isPending(response: unknown): boolean {
  return typeof response === 'object' && response !== null && (response as Record<string, unknown>)['__idempotencyPending'] === true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Db) {}

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    const rows = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
      .limit(1)
    const row = rows[0]
    if (!row || isPending(row.response)) {
      return undefined
    }
    return row.response as T
  }

  async put<T>(scope: string, key: string, response: T): Promise<void> {
    await this.db
      .insert(idempotencyKeys)
      .values({ scope, key, response: response as Record<string, unknown>, createdAt: new Date() })
      .onConflictDoUpdate({
        target: [idempotencyKeys.scope, idempotencyKeys.key],
        set: { response: response as Record<string, unknown> },
      })
  }

  async release(scope: string, key: string): Promise<void> {
    // Only the caller holding the claim ever calls this (see the port's own
    // doc comment) — no other writer can be racing this row, so an
    // unconditional delete by (scope, key) is safe.
    await this.db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
  }

  async claim<T>(scope: string, key: string, options?: ClaimOptions): Promise<ClaimOutcome<T>> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const deadline = Date.now() + timeoutMs

    const inserted = await this.db
      .insert(idempotencyKeys)
      .values({ scope, key, response: PENDING_MARKER, createdAt: new Date() })
      .onConflictDoNothing()
      .returning({ scope: idempotencyKeys.scope })
    if (inserted.length > 0) {
      return { kind: 'claimed' }
    }

    // Someone else claimed first — poll for their completion rather than
    // redoing the work. dev-logs/013: without this, two concurrent callers
    // with the same key both raced past the gate check and both appended
    // their own copy of the same money events.
    while (Date.now() < deadline) {
      const rows = await this.db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
        .limit(1)
      const row = rows[0]
      if (row && !isPending(row.response)) {
        return { kind: 'completed', response: row.response as T }
      }
      if (!row) {
        // The claimant released (failed) between our insert-conflict and
        // this read — the key is free again. Try to claim it ourselves.
        const retry = await this.db
          .insert(idempotencyKeys)
          .values({ scope, key, response: PENDING_MARKER, createdAt: new Date() })
          .onConflictDoNothing()
          .returning({ scope: idempotencyKeys.scope })
        if (retry.length > 0) {
          return { kind: 'claimed' }
        }
      }
      await sleep(pollIntervalMs)
    }
    return { kind: 'timed_out' }
  }
}
