/**
 * Re-issues one merchant credential without touching anything else.
 *
 *   npm run db:issue-token -- audit_trail
 *   npm run db:issue-token -- merchant_api mer_clinic
 *   npm run db:issue-token -- both
 *
 * WHY THIS EXISTS, given `db:seed` already prints both tokens
 *
 * `db:seed` is a *demo-ready* seed: it writes the clinic, Dr. Rao, the
 * service and policy v4, and issues both credentials. Against a live
 * deployment that is more than you want — re-running it to recover one lost
 * token also rotates the other, so recovering the viewer's token silently
 * breaks whatever was using the merchant-api one.
 *
 * `issueToken` itself is already correctly scoped: it revokes only the
 * active row for the *same* (merchant, scope) pair (see
 * `postgres-merchant-auth.ts` — the partial unique index from migration 0011
 * permits exactly one active row per pair, so revoke-then-insert is what
 * makes re-issuing safe at all). So a single-scope caller is all that was
 * missing.
 *
 * The token is shown once and stored only as a hash, exactly as `seed.ts`
 * does — this is the sole moment the plaintext exists. Copy it down.
 *
 * The viewer's token is read at BUILD time by Vite (`VITE_AUDIT_TRAIL_TOKEN`,
 * baked into the bundle), so re-issuing `audit_trail` against a deployment
 * needs the viewer rebuilt and redeployed before it takes effect. The
 * merchant-api token is read per request and needs no redeploy.
 */
import { requireDatabaseUrl } from '../build-deps.js'
import { loadEnvFile } from '../load-env.js'
import type { CredentialScope } from '../../ports/merchant-auth.js'
import { createDbClient } from './client.js'
import { PostgresMerchantAuthStore } from './postgres-merchant-auth.js'
import { SEED_MERCHANT_ID } from './seed-data.js'

loadEnvFile()

const SCOPES: readonly CredentialScope[] = ['merchant_api', 'audit_trail']

const [scopeArg, merchantIdArg = SEED_MERCHANT_ID] = process.argv.slice(2)

if (!scopeArg || (scopeArg !== 'both' && !SCOPES.includes(scopeArg as CredentialScope))) {
  console.error('usage: npm run db:issue-token -- <merchant_api|audit_trail|both> [merchantId]')
  console.error(`       merchantId defaults to ${SEED_MERCHANT_ID}`)
  process.exit(1)
}

const requested: readonly CredentialScope[] = scopeArg === 'both' ? SCOPES : [scopeArg as CredentialScope]

async function issue(): Promise<void> {
  const { sql, db } = createDbClient(requireDatabaseUrl())
  try {
    // Fail loudly rather than issuing a credential for a merchant that does
    // not exist — the foreign key would reject it anyway, but a typo'd
    // merchantId should say so in words, not as a constraint violation.
    const rows = await sql`SELECT merchant_id FROM merchants WHERE merchant_id = ${merchantIdArg}`
    if (rows.length === 0) {
      console.error(`no such merchant: ${merchantIdArg}`)
      process.exitCode = 1
      return
    }

    const store = new PostgresMerchantAuthStore(db)

    for (const scope of requested) {
      const { token } = await store.issueToken(merchantIdArg, scope)
      console.log(`\n${scope} token for ${merchantIdArg}:`)
      console.log(`  ${token}`)
    }

    console.log('\nThis is the only time these print — they are stored as hashes.')
    console.log('Any previously active token for the same scope is now revoked; other scopes are untouched.')
    if (requested.includes('audit_trail')) {
      console.log('\naudit_trail is baked into the viewer bundle at build time (VITE_AUDIT_TRAIL_TOKEN):')
      console.log('rebuild and redeploy latch-viewer before it takes effect.')
    }
  } finally {
    await sql.end()
  }
}

await issue()
