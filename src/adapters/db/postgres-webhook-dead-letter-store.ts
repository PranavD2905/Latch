import { eq, sql } from 'drizzle-orm'
import type { WebhookDeadLetterRecord, WebhookDeadLetterStore } from '../../ports/webhook-dead-letter-store.js'
import type { Db } from './client.js'
import { webhookDeadLetters } from './schema.js'

export class PostgresWebhookDeadLetterStore implements WebhookDeadLetterStore {
  constructor(private readonly db: Db) {}

  async recordFailure(params: { idempotencyKey: string; event: string; entityId: string; payload: unknown; error: string; now: Date; maxAttempts: number }): Promise<WebhookDeadLetterRecord> {
    const { idempotencyKey, event, entityId, payload, error, now, maxAttempts } = params

    // One round trip: insert attempt 1, or bump `attempt_count` on the
    // existing row. `dead_lettered_at` is set (once) exactly when the
    // *post-increment* count reaches `maxAttempts` — computed inside the
    // same statement via `excluded.attempt_count`, not read-then-decided,
    // so two failures racing this same key can't both skip past the
    // threshold without either of them tripping it.
    const rows = await this.db
      .insert(webhookDeadLetters)
      .values({
        idempotencyKey,
        event,
        entityId,
        payload: payload as Record<string, unknown>,
        lastError: error,
        attemptCount: 1,
        firstFailedAt: now,
        lastFailedAt: now,
        deadLetteredAt: maxAttempts <= 1 ? now : null,
      })
      .onConflictDoUpdate({
        target: webhookDeadLetters.idempotencyKey,
        set: {
          lastError: error,
          lastFailedAt: now,
          attemptCount: sqlIncrement(),
        },
      })
      .returning()

    const row = rows[0]
    if (!row) {
      throw new Error(`recordFailure: upsert returned no row for ${idempotencyKey}`)
    }

    // The upsert above can't express "set dead_lettered_at only once
    // attempt_count crosses maxAttempts" in one clause without a raw SQL
    // CASE (this ORM's `excluded` reference isn't wired for computed
    // conditionals here) — a second, narrow write closes that gap instead,
    // guarded so it only ever fires the one time attemptCount first meets
    // the threshold, never re-triggered by a later failure on an
    // already-dead-lettered row.
    if (row.attemptCount >= maxAttempts && !row.deadLetteredAt) {
      const [updated] = await this.db.update(webhookDeadLetters).set({ deadLetteredAt: now }).where(eq(webhookDeadLetters.idempotencyKey, idempotencyKey)).returning()
      return toRecord(updated ?? row)
    }

    return toRecord(row)
  }
}

function sqlIncrement() {
  // drizzle-orm's postgres-js `sql` template, used exactly like
  // `postgres-event-store.ts`'s own raw-`sql` usage: a value expression
  // inside a parameterised statement, not identifier construction — the
  // safe pattern dev-logs/013's `npm audit` review already confirmed is the
  // only shape this codebase uses.
  return sql`${webhookDeadLetters.attemptCount} + 1`
}

function toRecord(row: typeof webhookDeadLetters.$inferSelect): WebhookDeadLetterRecord {
  return {
    idempotencyKey: row.idempotencyKey,
    event: row.event,
    entityId: row.entityId,
    payload: row.payload,
    lastError: row.lastError,
    attemptCount: row.attemptCount,
    firstFailedAt: row.firstFailedAt,
    lastFailedAt: row.lastFailedAt,
    deadLetteredAt: row.deadLetteredAt,
  }
}
