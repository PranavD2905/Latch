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
 *
 * **This budget stops working the moment any service sets `replicas > 1`.**
 * `DB_POOL_MAX` x 5 processes was already this deployment's whole plan
 * (three services, no replicas — docs/07-deployment.md's `.railway/railway.ts`
 * never sets `replicas`); turning replicas on for even one service multiplies
 * that service's connection count by the replica count, with nothing here to
 * stop it. `idle_timeout`/`max_lifetime` below buy some slack by returning
 * connections a replica isn't actively using, but they don't remove the
 * ceiling — the real fix for genuine horizontal scaling is a connection
 * pooler in front of Postgres (PgBouncer in transaction mode, or Railway's
 * own Postgres connection-pooling add-on), so N app replicas share a much
 * smaller number of real Postgres connections instead of each holding their
 * own `DB_POOL_MAX`. `DB_TRANSACTION_POOLER=true` below is this file's half
 * of that: transaction-mode pooling doesn't support session-scoped prepared
 * statements, so `prepare` must be turned off when one sits in front of this
 * pool — see the flag's own comment.
 */
export function createDbClient(databaseUrl: string) {
  const max = Number(process.env['DB_POOL_MAX'] ?? 5)
  const usingTransactionPooler = process.env['DB_TRANSACTION_POOLER'] === 'true'
  const sql = postgres(databaseUrl, {
    max,
    // Proactively hands idle/long-lived connections back rather than
    // holding `max` open indefinitely regardless of actual load — cheap
    // insurance against a replica sitting on connections it isn't using,
    // though it does not raise the hard ceiling `max` x process/replica
    // count still sets (see the pooler note above).
    idle_timeout: Number(process.env['DB_IDLE_TIMEOUT_SECONDS'] ?? 60),
    max_lifetime: Number(process.env['DB_MAX_LIFETIME_SECONDS'] ?? 30 * 60),
    // `DB_TRANSACTION_POOLER=true` — set this when `DATABASE_URL` points at
    // a transaction-mode pooler (PgBouncer, Railway's Postgres connection
    // pooling add-on) rather than Postgres directly. Transaction-mode
    // pooling hands out a different backend connection per transaction, so
    // a session-scoped prepared statement from one transaction can silently
    // run against the wrong backend in the next — `postgres-js`'s `prepare`
    // option must be off in that mode. Left on (the `postgres-js` default)
    // for a direct connection, where prepared statements are safe and
    // measurably faster.
    prepare: !usingTransactionPooler,
  })
  const db = drizzle(sql, { schema })
  return { sql, db }
}

export type Db = ReturnType<typeof createDbClient>['db']
