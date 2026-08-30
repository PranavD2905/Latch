import { and, eq, isNull } from 'drizzle-orm'
import { generateMerchantToken, hashesMatch, prefixOf } from '../auth/token-crypto.js'
import type { CredentialScope, MerchantAuthStore } from '../../ports/merchant-auth.js'
import type { Db } from './client.js'
import { merchantCredentials } from './schema.js'

export class PostgresMerchantAuthStore implements MerchantAuthStore {
  constructor(private readonly db: Db) {}

  async verifyToken(token: string, scope: CredentialScope): Promise<{ merchantId: string } | undefined> {
    const prefix = prefixOf(token)
    if (!prefix) return undefined // wrong shape entirely — not even worth a query

    // The prefix is PRIMARY KEY, so this is a single indexed row lookup
    // regardless of how many merchants/credentials exist — the auth check
    // that gates every merchant-api/audit-trail request stays O(1) as the
    // tenant count grows, never a linear scan over every merchant's token.
    const rows = await this.db
      .select()
      .from(merchantCredentials)
      .where(and(eq(merchantCredentials.tokenPrefix, prefix), eq(merchantCredentials.scope, scope), isNull(merchantCredentials.revokedAt)))
      .limit(1)
    const row = rows[0]
    if (!row) return undefined
    if (!hashesMatch(token, row.tokenHash)) return undefined // prefix collision or corrupted token — never trust the prefix match alone
    return { merchantId: row.merchantId }
  }

  async issueToken(merchantId: string, scope: CredentialScope): Promise<{ token: string }> {
    const generated = generateMerchantToken()
    const now = new Date()

    await this.db.transaction(async (tx) => {
      // Rotation, not accumulation: revoke whatever was active for this
      // (merchant, scope) first — the partial unique index (migration 0011)
      // only ever blocks two *active* rows for the same pair, so this order
      // (revoke, then insert) is what makes re-issuing safe to call at all.
      await tx
        .update(merchantCredentials)
        .set({ revokedAt: now })
        .where(and(eq(merchantCredentials.merchantId, merchantId), eq(merchantCredentials.scope, scope), isNull(merchantCredentials.revokedAt)))

      await tx.insert(merchantCredentials).values({
        tokenPrefix: generated.prefix,
        merchantId,
        tokenHash: generated.hash,
        scope,
        createdAt: now,
      })
    })

    return { token: generated.token }
  }
}
