/**
 * One-command demo-ready seed: a clinic, Dr. Rao, one service, and policy v1
 * matching the worked example in docs/03-domain-model.md §2. Fixed IDs so
 * re-running is safe (`onConflictDoNothing`) and the MCP client / tests can
 * refer to them by name instead of looking them up first.
 */
import { createDbClient } from './client.js'
import { merchants, policies, practitioners, services } from './schema.js'
import { SEED_MERCHANT_ID, SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from './seed-data.js'

process.loadEnvFile?.('.env')

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
      policyId: 'pol_v1',
      merchantId: SEED_MERCHANT_ID,
      version: 1,
      depositType: 'fixed',
      depositAmountPaise: 30000, // ₹300
      cancellationLadder: [
        { hoursBefore: 48, retainPct: 0 },
        { hoursBefore: 12, retainPct: 50 },
        { hoursBefore: 0, retainPct: 100 },
      ],
      noShowFeePaise: 40000, // ₹400
      noShowGraceMinutes: 15,
      mandateCeilingPaise: 150000, // ₹1,500
      holdTtlSeconds: 600,
      maxConcurrentHoldsPerAgent: 3,
      createdAt: now,
    })
    .onConflictDoNothing()

  await sql.end()
  console.log('seed complete:', { merchant: SEED_MERCHANT_ID, practitioner: SEED_PRACTITIONER_ID, service: SEED_SERVICE_ID })
}

await seed()
