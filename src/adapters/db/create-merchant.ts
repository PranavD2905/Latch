/**
 * Migration 0011 — onboards a second (third, Nth) merchant onto an already-
 * running Latch deployment, with no code change and no redeploy. This is
 * the concrete proof of the multi-tenancy claim in docs/01-architecture.md
 * §10: everything below is exactly the shape `seed.ts` already uses for the
 * one demo merchant, just parameterised and runnable at any time against a
 * live database, because `merchantId` was already threaded through every
 * catalog/booking/event row and check (see `src/app/tenant-guard.ts`,
 * `postgres-event-store.ts`) rather than assumed to be a single fixed value.
 *
 *   npm run db:create-merchant -- "Downtown Dental" "Dr. Iyer" "Cleaning, 30 min" 30 60000
 *
 * Positional args: merchant name, practitioner name, service name, service
 * duration in minutes, service price in paise. All but the merchant name
 * have sensible defaults (a generic consult), since the point of this
 * script is proving the auth/tenancy model, not modelling a real clinic.
 */
import { ulid } from 'ulid'
import { loadEnvFile } from '../load-env.js'
import { createDbClient } from './client.js'
import { PostgresMerchantAuthStore } from './postgres-merchant-auth.js'
import { merchants, policies, practitioners, services } from './schema.js'

loadEnvFile()

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set')
}

const [merchantName, practitionerName = 'Dr. Practitioner', serviceName = 'General consult, 30 min', durationArg = '30', priceArg = '80000'] = process.argv.slice(2)

if (!merchantName) {
  console.error('usage: npm run db:create-merchant -- "Merchant name" ["Practitioner name"] ["Service name"] [durationMinutes] [pricePaise]')
  process.exit(1)
}

async function createMerchant(): Promise<void> {
  const { sql, db } = createDbClient(databaseUrl!)
  const now = new Date()

  const merchantId = `mer_${ulid()}`
  const practitionerId = `prac_${ulid()}`
  const serviceId = `svc_${ulid()}`

  await db.insert(merchants).values({ merchantId, name: merchantName!, razorpayAccountId: `acc_test_${ulid()}`, createdAt: now })

  await db.insert(practitioners).values({
    practitionerId,
    merchantId,
    name: practitionerName,
    workingHours: {
      mon: [['09:00', '13:00'], ['14:00', '18:00']],
      tue: [['09:00', '13:00'], ['14:00', '18:00']],
      wed: [['09:00', '13:00'], ['14:00', '18:00']],
      thu: [['09:00', '13:00'], ['14:00', '18:00']],
      fri: [['09:00', '13:00'], ['14:00', '18:00']],
    },
    createdAt: now,
  })

  await db.insert(services).values({
    serviceId,
    merchantId,
    name: serviceName,
    durationMinutes: Number(durationArg),
    pricePaise: Number(priceArg),
    createdAt: now,
  })

  await db.insert(policies).values({
    policyId: `pol_${ulid()}`,
    merchantId,
    version: 1,
    depositType: 'fixed',
    depositAmountPaise: 30000, // ₹300 — same defaults as seed.ts; a real onboarding flow would take these as args too
    cancellationLadder: [
      { hoursBefore: 48, retainPct: 0 },
      { hoursBefore: 12, retainPct: 50 },
      { hoursBefore: 0, retainPct: 100 },
    ],
    noShowFeePaise: 40000, // ₹400
    noShowGraceMinutes: 15,
    holdTtlSeconds: 600,
    maxConcurrentHoldsPerAgent: 3,
    holdRateLimitPerMinute: 10,
    createdAt: now,
  })

  const merchantAuthStore = new PostgresMerchantAuthStore(db)
  const merchantApiToken = await merchantAuthStore.issueToken(merchantId, 'merchant_api')
  const auditTrailToken = await merchantAuthStore.issueToken(merchantId, 'audit_trail')

  await sql.end()

  console.log('merchant created:', { merchantId, practitionerId, serviceId })
  console.log(`\nagents reach this merchant at: POST /mcp/${merchantId}  (any deployed latch-mcp instance — no redeploy needed)`)
  console.log('\nmerchant-api token (Bearer token against latch-merchant-api):')
  console.log(`  ${merchantApiToken.token}`)
  console.log('\naudit-trail viewer token (VITE_AUDIT_TRAIL_TOKEN for a viewer build scoped to this merchant):')
  console.log(`  ${auditTrailToken.token}`)
}

await createMerchant()
