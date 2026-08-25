import { sql, type SQL } from 'drizzle-orm'
import type { Db } from './client.js'
import { policies } from './schema.js'

/**
 * Delete policy rows in test fixtures, past the `policies_immutable` trigger
 * (migration 0010).
 *
 * Published policies are append-only in production: every money event cites
 * `authority.policyVersion`, so a policy row is a historical fact the audit
 * trail resolves against, not a config record. Mutating or deleting one would
 * make already-settled events cite an authority that no longer says what it
 * said — the trail would lie rather than merely go stale.
 *
 * Tests still have to clean up rows they created. The trigger honours a
 * transaction-local escape hatch, and this is the only place that sets it:
 * deliberately, visibly, and scoped by `SET LOCAL` to a single transaction, so
 * it cannot leak onto a pooled connection a later query reuses.
 *
 * Do not call this from application code. If a production path ever needs to
 * change a policy, the answer is `publishPolicy()` — a new version — never a
 * mutation of an old one.
 */
export async function deletePoliciesForTest(db: Db, where: SQL): Promise<void> {
  await db.transaction(async (tx) => {
    // The function form of `SET LOCAL`: transaction-scoped, reverted on commit
    // or rollback.
    await tx.execute(sql`SELECT set_config('latch.allow_policy_mutation', 'on', true)`)
    await tx.delete(policies).where(where)
  })
}
