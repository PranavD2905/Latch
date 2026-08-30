import type postgres from 'postgres'

/**
 * Runs `fn` only if no other session currently holds the named lock;
 * otherwise a no-op (`ran: false`). This is what makes it safe to set
 * `replicas > 1` on `latch-mcp` (docs/07-deployment.md's topology never set
 * `replicas` at all — see the doc's own connection-budget note) without
 * every replica's background-worker tick doing the same work N times over.
 * `FOR UPDATE SKIP LOCKED` already makes the row-level claims inside each
 * job safe to run from more than one process at once, but "safe" isn't
 * "free": the reconciliation worker in particular makes a real Razorpay
 * call per candidate (`reconciliation-worker.ts`), so N replicas each
 * running a full tick means N times the external API load for the same
 * unit of work, not more work getting done.
 *
 * A session-level advisory lock (`pg_try_advisory_lock`/`pg_advisory_unlock`),
 * not the `pg_advisory_xact_lock` used elsewhere in this codebase
 * (`postgres-event-store.ts`'s `lockAgent`) — a background tick spans
 * several independent transactions (one per claimed booking), so there is
 * no single transaction to scope the lock to. `sql.reserve()` pins one
 * connection for the lock's lifetime specifically so the acquire and the
 * release are guaranteed to run on the same session — `pg_advisory_unlock`
 * only works from the session that took the lock.
 */
export async function withGlobalLock(sql: postgres.Sql, lockKey: string, fn: () => Promise<void>): Promise<{ ran: boolean }> {
  const reserved = await sql.reserve()
  try {
    const rows = await reserved`select pg_try_advisory_lock(hashtext(${lockKey})) as acquired`
    const acquired = rows[0]?.['acquired'] === true
    if (!acquired) {
      return { ran: false }
    }
    try {
      await fn()
      return { ran: true }
    } finally {
      await reserved`select pg_advisory_unlock(hashtext(${lockKey}))`
    }
  } finally {
    reserved.release()
  }
}
