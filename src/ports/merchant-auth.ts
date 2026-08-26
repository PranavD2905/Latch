/**
 * Migration 0011 — real multi-tenant auth. Outbound port over per-merchant
 * API credentials: issuing a new token (merchant onboarding, rotation) and
 * verifying a presented one (every request into `latch-merchant-api` /
 * `latch-viewer`). Kept separate from `CatalogRepo` because this is
 * security-sensitive, narrowly-scoped data (hashes, not reference data an
 * agent or a merchant's own dashboard would ever read back).
 */
export type CredentialScope = 'merchant_api' | 'audit_trail'

export interface MerchantAuthStore {
  /**
   * Verifies a presented token against the credential store and resolves the
   * merchant it belongs to. `undefined` for an unknown, revoked, or
   * wrong-scope token — deliberately the same shape as "not found," so a
   * caller can't distinguish "this token doesn't exist" from "this token
   * exists but isn't valid for this scope."
   */
  verifyToken(token: string, scope: CredentialScope): Promise<{ merchantId: string } | undefined>

  /**
   * Issues a brand-new credential for `merchantId` in `scope`, revoking any
   * currently-active credential in that same scope first (rotation, not
   * accumulation — see the partial unique index in migration 0011). Returns
   * the plaintext token exactly once; only its hash is ever persisted.
   */
  issueToken(merchantId: string, scope: CredentialScope): Promise<{ token: string }>
}
