import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

/**
 * `postgres-js` defaults `max` to 10 per instance. Fine on a local Postgres.app
 * with one process talking to it — not fine against Railway's managed
 * Postgres once Slice 7 splits the app into three separate long-running
 * processes (MCP, merchant API, audit-trail/viewer), each holding its own
 * pool: 3 x 10 risks getting close to a small managed instance's connection
 * limit, and short-lived `db:migrate`/`db:seed` runs stack on top of that.
 * Capped low by default; override with `DB_POOL_MAX` if a given deployment
 * has headroom to spare.
 */
export function createDbClient(databaseUrl: string) {
  const max = Number(process.env['DB_POOL_MAX'] ?? 5)
  const sql = postgres(databaseUrl, { max })
  const db = drizzle(sql, { schema })
  return { sql, db }
}

export type Db = ReturnType<typeof createDbClient>['db']
