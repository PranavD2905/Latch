import { and, eq } from 'drizzle-orm'
import type { IdempotencyStore } from '../../ports/idempotency-store.js'
import type { Db } from './client.js'
import { idempotencyKeys } from './schema.js'

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Db) {}

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    const rows = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
      .limit(1)
    const row = rows[0]
    return row ? (row.response as T) : undefined
  }

  async put<T>(scope: string, key: string, response: T): Promise<void> {
    await this.db
      .insert(idempotencyKeys)
      .values({ scope, key, response: response as Record<string, unknown>, createdAt: new Date() })
      .onConflictDoNothing()
  }
}
