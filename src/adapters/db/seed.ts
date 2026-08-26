/**
 * One-command demo-ready seed: a clinic, Dr. Rao, one service, and policy v4
 * — the exact numbers of the worked example in docs/03-domain-model.md §2
 * (which literally quotes `policy_version: 4`; the ladder/deposit/no-show
 * figures were already identical to this seed pre-Slice-7, only the version
 * number and policyId are new). Fixed IDs so re-running is safe
 * (`onConflictDoNothing`) and the MCP client / tests can refer to them by
 * name instead of looking them up first.
 */
import { loadEnvFile } from '../load-env.js'
import { createDbClient } from './client.js'
import { PostgresMerchantAuthStore } from './postgres-merchant-auth.js'
import { merchants, policies, practitioners, services } from './schema.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from './seed-data.js'

loadEnvFile()

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set')
}

async function seed() {
  const { sql, db } = createDbClient(databaseUrl!)
  const now = new Date()

  await db
    .insert(merchants)
    .values({
      merchantId: SEED_MERCHANT_ID,
      name: 'Latch Dermatology Clinic',
      razorpayAccountId: 'acc_test_demo',
      createdAt: now,
    })
    .onConflictDoNothing()

  await db
    .insert(practitioners)
    .values({
      practitionerId: SEED_PRACTITIONER_ID,
      merchantId: SEED_MERCHANT_ID,
      name: 'Dr. Rao',
      workingHours: {
        mon: [['09:00', '13:00'], ['14:00', '18:00']],
        tue: [['09:00', '13:00'], ['14:00', '18:00']],
        wed: [['09:00', '13:00'], ['14:00', '18:00']],
        thu: [['09:00', '13:00'], ['14:00', '18:00']],
        fri: [['09:00', '13:00'], ['14:00', '18:00']],
      },
      createdAt: now,
    })
    .onConflictDoNothing()

  await db
    .insert(services)
    .values({
      serviceId: SEED_SERVICE_ID,
      merchantId: SEED_MERCHANT_ID,
      name: 'Dermatology consult',
      durationMinutes: 30,
      pricePaise: 80000, // ₹800
      createdAt: now,
    })
    .onConflictDoNothing()

  await db
    .insert(policies)
    .values({
      policyId: 'pol_v4',
      merchantId: SEED_MERCHANT_ID,
      version: 4,
      depositType: 'fixed',
      depositAmountPaise: 30000, // ₹300
      cancellationLadder: [
        { hoursBefore: 48, retainPct: 0 },
        { hoursBefore: 12, retainPct: 50 },
        { hoursBefore: 0, retainPct: 100 },
      ],
      noShowFeePaise: 40000, // ₹400
      noShowGraceMinutes: 15,
      holdTtlSeconds: 600,
      maxConcurrentHoldsPerAgent: 3,
      // dev-logs/014, gap 2: 10 holds/minute/agent — generous for a real
      // browsing agent exploring options (well above the 3-concurrent-hold
      // ceiling even at a brisk hold/release/re-hold pace), tight enough to
      // make sitting at the ceiling indefinitely via rapid re-holding costly
      // for a hostile one.
      holdRateLimitPerMinute: 10,
      createdAt: now,
    })
    .onConflictDoNothing()

  // Migration 0011: mint the seed merchant's merchant-api and audit-trail
  // credentials — real multi-tenant auth means there's no static
  // MERCHANT_API_TOKEN/AUDIT_TRAIL_TOKEN env var to fall back to anymore, so
  // seeding a merchant and having no way to authenticate as it would leave
  // the demo unrunnable. Printed once, in plaintext, exactly like any other
  // freshly-issued API key — only the hash is ever persisted
  // (`token-crypto.ts`), so this is the only place either value is ever
  // visible again. Re-running the seed rotates both (issueToken revokes the
  // previous active credential first), which is fine for a demo merchant but
  // worth knowing before scripting a re-seed against anything real.
  const merchantAuthStore = new PostgresMerchantAuthStore(db)
  const merchantApiToken = await merchantAuthStore.issueToken(SEED_MERCHANT_ID, 'merchant_api')
  const auditTrailToken = await merchantAuthStore.issueToken(SEED_MERCHANT_ID, 'audit_trail')

  await sql.end()
  console.log('seed complete:', { merchant: SEED_MERCHANT_ID, practitioner: SEED_PRACTITIONER_ID, service: SEED_SERVICE_ID })
  console.log('\nmerchant-api token (use as a Bearer token against latch-merchant-api, e.g. decline_booking/set_policy):')
  console.log(`  ${merchantApiToken.token}`)
  console.log('\naudit-trail viewer token (set as VITE_AUDIT_TRAIL_TOKEN at build time):')
  console.log(`  ${auditTrailToken.token}`)
  console.log('\nneither value is stored in plaintext anywhere — this is the only place either prints.')
}

await seed()
