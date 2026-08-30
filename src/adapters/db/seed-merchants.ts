/**
 * Seeds a directory of demo merchants — 20 clinics, each with its own
 * practitioners, services, and policy — on top of whatever `seed.ts` already
 * created. The point is a believable multi-tenant surface to browse: an agent
 * reaches any of them at `POST /mcp/:merchantId` with no token, no
 * partnership, and no redeploy (docs/01-architecture.md §10, migration 0011).
 *
 *   npm run db:seed-merchants            # insert/refresh the 20 merchants
 *   npm run db:seed-merchants -- --tokens  # also mint merchant-api/audit-trail credentials
 *
 * **Deterministic, human-readable ids** (`mer_kanika_skin`, not `mer_<ulid>`)
 * for two reasons: re-running is safe — every insert is `onConflictDoNothing`,
 * so this is idempotent rather than creating 20 more clinics each time — and
 * `POST /mcp/mer_kanika_skin` is a far better thing to show than a ULID.
 *
 * **Tokens are opt-in, and off by default.** The agent-facing MCP surface is
 * deliberately unauthenticated (`streamable-http-server.ts`), so none of these
 * merchants needs a credential to be browsed, held, or booked against — which
 * is the whole thesis. Credentials only gate the *merchant's own* surfaces
 * (decline/mark-no-show/set_policy, and the audit-trail viewer). Minting 40
 * secrets nobody asked for and printing them to a terminal would be worse than
 * useless; worse, `issueToken` revokes the previous active credential, so
 * re-running with `--tokens` silently rotates every merchant's keys. Pass the
 * flag when you actually want them.
 *
 * **The policy shapes are deliberately varied**, not copy-pasted. Since the
 * payment-link work, how many payment legs a booking has is a policy
 * consequence: deposit and no-show fee are each independently optional, and
 * the session-complete mandate is `price - (deposit ?? 0)`. So this directory
 * intentionally contains one-leg, two-leg, and three-leg merchants — the
 * fastest way to see that behaviour is to book against different ones. The
 * `legs` column in the summary this prints says which is which.
 */
import { requireDatabaseUrl } from '../build-deps.js'
import { loadEnvFile } from '../load-env.js'
import { createDbClient } from './client.js'
import { PostgresMerchantAuthStore } from './postgres-merchant-auth.js'
import { merchants, policies, practitioners, services } from './schema.js'

loadEnvFile()

const issueTokens = process.argv.includes('--tokens')
const databaseUrl = requireDatabaseUrl()

type Hours = Record<string, [string, string][]>

/** Mon–Fri, two sessions with a lunch break — the most common clinic shape. */
const STANDARD: Hours = {
  mon: [['09:00', '13:00'], ['14:00', '18:00']],
  tue: [['09:00', '13:00'], ['14:00', '18:00']],
  wed: [['09:00', '13:00'], ['14:00', '18:00']],
  thu: [['09:00', '13:00'], ['14:00', '18:00']],
  fri: [['09:00', '13:00'], ['14:00', '18:00']],
}
/** Includes Saturday — plenty of Indian clinics run a six-day week. */
const SIX_DAY: Hours = { ...STANDARD, sat: [['09:00', '13:00']] }
/** Later start, runs into the evening — diagnostics and dental especially. */
const EVENING: Hours = {
  mon: [['11:00', '15:00'], ['16:00', '20:00']],
  tue: [['11:00', '15:00'], ['16:00', '20:00']],
  wed: [['11:00', '15:00'], ['16:00', '20:00']],
  thu: [['11:00', '15:00'], ['16:00', '20:00']],
  fri: [['11:00', '15:00'], ['16:00', '20:00']],
  sat: [['10:00', '14:00']],
}
/** A short three-day week — a visiting consultant. */
const PART_TIME: Hours = {
  tue: [['10:00', '13:00']],
  thu: [['10:00', '13:00']],
  sat: [['10:00', '14:00']],
}

const LADDER_STANDARD = [
  { hoursBefore: 48, retainPct: 0 },
  { hoursBefore: 12, retainPct: 50 },
  { hoursBefore: 0, retainPct: 100 },
]
/** Stricter — high-demand slots where a late cancel is expensive to backfill. */
const LADDER_STRICT = [
  { hoursBefore: 72, retainPct: 0 },
  { hoursBefore: 24, retainPct: 50 },
  { hoursBefore: 6, retainPct: 75 },
  { hoursBefore: 0, retainPct: 100 },
]
/** Lenient — full refund right up to 12h out. */
const LADDER_LENIENT = [
  { hoursBefore: 12, retainPct: 0 },
  { hoursBefore: 0, retainPct: 50 },
]

interface MerchantSpec {
  slug: string
  name: string
  city: string
  practitioners: { name: string; hours: Hours }[]
  services: { name: string; minutes: number; pricePaise: number }[]
  /** `undefined` = this merchant takes no upfront deposit at all. */
  depositPaise: number | undefined
  /** `undefined` = no no-show fee; grace is paired with it automatically. */
  noShowPaise: number | undefined
  ladder: { hoursBefore: number; retainPct: number }[]
  holdTtlSeconds: number
}

/**
 * Twenty clinics. Prices are in paise and chosen to be plausible for the
 * specialty and city rather than round demo numbers, so a browsing agent sees
 * a directory that reads like a real market.
 */
const SPECS: MerchantSpec[] = [
  {
    slug: 'kanika_skin', name: 'Kanika Skin & Hair Clinic', city: 'Bengaluru',
    practitioners: [{ name: 'Dr. Kanika Menon', hours: STANDARD }, { name: 'Dr. Arjun Pillai', hours: PART_TIME }],
    services: [{ name: 'Dermatology consult', minutes: 30, pricePaise: 90000 }, { name: 'Acne follow-up', minutes: 15, pricePaise: 45000 }],
    depositPaise: 30000, noShowPaise: 40000, ladder: LADDER_STANDARD, holdTtlSeconds: 600,
  },
  {
    slug: 'meridian_dental', name: 'Meridian Dental Care', city: 'Mumbai',
    practitioners: [{ name: 'Dr. Farhan Qureshi', hours: EVENING }, { name: 'Dr. Sneha Kulkarni', hours: SIX_DAY }],
    services: [{ name: 'Scaling & polishing', minutes: 45, pricePaise: 150000 }, { name: 'Root canal, single sitting', minutes: 90, pricePaise: 650000 }],
    depositPaise: 100000, noShowPaise: 50000, ladder: LADDER_STRICT, holdTtlSeconds: 900,
  },
  {
    slug: 'sunrise_physio', name: 'Sunrise Physiotherapy', city: 'Pune',
    practitioners: [{ name: 'Dr. Rhea Deshmukh', hours: SIX_DAY }],
    services: [{ name: 'Physiotherapy session', minutes: 45, pricePaise: 80000 }, { name: 'Post-op rehab review', minutes: 30, pricePaise: 60000 }],
    depositPaise: 20000, noShowPaise: 30000, ladder: LADDER_STANDARD, holdTtlSeconds: 600,
  },
  {
    slug: 'aster_eye', name: 'Aster Eye Centre', city: 'Chennai',
    practitioners: [{ name: 'Dr. Lakshmi Narayanan', hours: STANDARD }],
    services: [{ name: 'Comprehensive eye exam', minutes: 40, pricePaise: 120000 }],
    depositPaise: 40000, noShowPaise: undefined, ladder: LADDER_STANDARD, holdTtlSeconds: 600,
  },
  {
    slug: 'bloom_womens', name: "Bloom Women's Wellness", city: 'Hyderabad',
    practitioners: [{ name: 'Dr. Ayesha Siddiqui', hours: STANDARD }, { name: 'Dr. Priya Reddy', hours: SIX_DAY }],
    services: [{ name: 'Gynaecology consult', minutes: 30, pricePaise: 110000 }, { name: 'Antenatal check', minutes: 25, pricePaise: 85000 }],
    depositPaise: 35000, noShowPaise: 45000, ladder: LADDER_STANDARD, holdTtlSeconds: 720,
  },
  {
    slug: 'northstar_ortho', name: 'NorthStar Orthopaedics', city: 'New Delhi',
    practitioners: [{ name: 'Dr. Vikram Sethi', hours: STANDARD }],
    services: [{ name: 'Orthopaedic consult', minutes: 30, pricePaise: 130000 }, { name: 'Fracture review', minutes: 20, pricePaise: 70000 }],
    depositPaise: 50000, noShowPaise: 60000, ladder: LADDER_STRICT, holdTtlSeconds: 600,
  },
  {
    // No deposit: talk therapy is commonly billed after the session, and the
    // no-show fee is what actually protects the slot.
    slug: 'calm_waters', name: 'Calm Waters Counselling', city: 'Kolkata',
    practitioners: [{ name: 'Ananya Bose, RCI-licensed', hours: EVENING }],
    services: [{ name: 'Individual therapy, 50 min', minutes: 50, pricePaise: 200000 }],
    depositPaise: undefined, noShowPaise: 100000, ladder: LADDER_LENIENT, holdTtlSeconds: 900,
  },
  {
    slug: 'vitalis_cardio', name: 'Vitalis Cardiology', city: 'Ahmedabad',
    practitioners: [{ name: 'Dr. Nilesh Trivedi', hours: STANDARD }],
    services: [{ name: 'Cardiology consult', minutes: 30, pricePaise: 160000 }, { name: 'Echocardiogram', minutes: 45, pricePaise: 250000 }],
    depositPaise: 60000, noShowPaise: 70000, ladder: LADDER_STRICT, holdTtlSeconds: 600,
  },
  {
    slug: 'littlesteps_paeds', name: 'LittleSteps Paediatrics', city: 'Jaipur',
    practitioners: [{ name: 'Dr. Meera Agarwal', hours: SIX_DAY }],
    services: [{ name: 'Paediatric consult', minutes: 20, pricePaise: 70000 }, { name: 'Vaccination visit', minutes: 15, pricePaise: 40000 }],
    depositPaise: undefined, noShowPaise: 25000, ladder: LADDER_LENIENT, holdTtlSeconds: 600,
  },
  {
    slug: 'radiance_cosmetic', name: 'Radiance Cosmetic Dermatology', city: 'Gurugram',
    practitioners: [{ name: 'Dr. Simran Ahuja', hours: EVENING }],
    services: [{ name: 'Laser hair reduction, session', minutes: 60, pricePaise: 450000 }, { name: 'Chemical peel', minutes: 40, pricePaise: 300000 }],
    depositPaise: 150000, noShowPaise: 200000, ladder: LADDER_STRICT, holdTtlSeconds: 1200,
  },
  {
    slug: 'clearvoice_ent', name: 'ClearVoice ENT', city: 'Lucknow',
    practitioners: [{ name: 'Dr. Imran Khan', hours: STANDARD }],
    services: [{ name: 'ENT consult', minutes: 25, pricePaise: 85000 }],
    depositPaise: 25000, noShowPaise: 35000, ladder: LADDER_STANDARD, holdTtlSeconds: 600,
  },
  {
    slug: 'anchor_sportsmed', name: 'Anchor Sports Medicine', city: 'Chandigarh',
    practitioners: [{ name: 'Dr. Gurpreet Sandhu', hours: SIX_DAY }, { name: 'Dr. Kabir Malhotra', hours: PART_TIME }],
    services: [{ name: 'Sports injury assessment', minutes: 45, pricePaise: 140000 }, { name: 'Return-to-play review', minutes: 30, pricePaise: 95000 }],
    depositPaise: 45000, noShowPaise: 55000, ladder: LADDER_STANDARD, holdTtlSeconds: 600,
  },
  {
    slug: 'prana_ayurveda', name: 'Prana Ayurveda', city: 'Kochi',
    practitioners: [{ name: 'Dr. Rajeev Nair', hours: SIX_DAY }],
    services: [{ name: 'Ayurvedic consultation', minutes: 45, pricePaise: 90000 }, { name: 'Panchakarma planning', minutes: 60, pricePaise: 180000 }],
    depositPaise: 30000, noShowPaise: undefined, ladder: LADDER_LENIENT, holdTtlSeconds: 900,
  },
  {
    slug: 'nova_diagnostics', name: 'Nova Diagnostics', city: 'Nagpur',
    practitioners: [{ name: 'Dr. Shalini Wankhede', hours: EVENING }],
    services: [{ name: 'Ultrasound, abdomen', minutes: 30, pricePaise: 190000 }, { name: 'X-ray, chest', minutes: 15, pricePaise: 55000 }],
    depositPaise: 50000, noShowPaise: undefined, ladder: LADDER_STANDARD, holdTtlSeconds: 600,
  },
  {
    slug: 'serene_derm', name: 'Serene Dermatology', city: 'Coimbatore',
    practitioners: [{ name: 'Dr. Divya Raman', hours: STANDARD }],
    services: [{ name: 'Skin consult', minutes: 30, pricePaise: 75000 }],
    depositPaise: 25000, noShowPaise: 30000, ladder: LADDER_STANDARD, holdTtlSeconds: 600,
  },
  {
    slug: 'apex_dental', name: 'Apex Dental Studio', city: 'Bhopal',
    practitioners: [{ name: 'Dr. Rohit Saxena', hours: SIX_DAY }],
    services: [{ name: 'Dental check-up', minutes: 30, pricePaise: 60000 }, { name: 'Tooth extraction', minutes: 45, pricePaise: 200000 }],
    depositPaise: 20000, noShowPaise: 40000, ladder: LADDER_STANDARD, holdTtlSeconds: 600,
  },
  {
    // The minimal case: no deposit, no no-show fee — exactly one payment leg
    // (the session-complete mandate for the full price).
    slug: 'mindful_path', name: 'Mindful Path Psychiatry', city: 'Indore',
    practitioners: [{ name: 'Dr. Sameer Joshi', hours: PART_TIME }],
    services: [{ name: 'Psychiatric evaluation', minutes: 60, pricePaise: 250000 }],
    depositPaise: undefined, noShowPaise: undefined, ladder: LADDER_LENIENT, holdTtlSeconds: 1200,
  },
  {
    slug: 'harmony_chiro', name: 'Harmony Chiropractic', city: 'Visakhapatnam',
    practitioners: [{ name: 'Dr. Anil Varma', hours: SIX_DAY }],
    services: [{ name: 'Chiropractic adjustment', minutes: 30, pricePaise: 100000 }],
    depositPaise: 30000, noShowPaise: 35000, ladder: LADDER_STANDARD, holdTtlSeconds: 600,
  },
  {
    slug: 'lotus_fertility', name: 'Lotus Fertility', city: 'Surat',
    practitioners: [{ name: 'Dr. Hetal Shah', hours: STANDARD }, { name: 'Dr. Manav Desai', hours: PART_TIME }],
    services: [{ name: 'Fertility consultation', minutes: 45, pricePaise: 280000 }, { name: 'Follow-up scan', minutes: 20, pricePaise: 120000 }],
    depositPaise: 100000, noShowPaise: 150000, ladder: LADDER_STRICT, holdTtlSeconds: 1800,
  },
  {
    // No deposit, but a real no-show fee — the two-leg shape from the other side.
    slug: 'cedar_family', name: 'Cedar Family Medicine', city: 'Bhubaneswar',
    practitioners: [{ name: 'Dr. Priyanka Mohanty', hours: SIX_DAY }],
    services: [{ name: 'General consult', minutes: 20, pricePaise: 50000 }, { name: 'Health check review', minutes: 30, pricePaise: 90000 }],
    depositPaise: undefined, noShowPaise: 20000, ladder: LADDER_LENIENT, holdTtlSeconds: 600,
  },
]

/** How many payment legs a booking against this merchant will actually have — see the file header. */
function legCount(spec: MerchantSpec): number {
  const cheapest = Math.min(...spec.services.map((s) => s.pricePaise))
  return (spec.depositPaise !== undefined ? 1 : 0) + (spec.noShowPaise !== undefined ? 1 : 0) + (cheapest - (spec.depositPaise ?? 0) > 0 ? 1 : 0)
}

async function seedMerchants(): Promise<void> {
  const { sql, db } = createDbClient(databaseUrl)
  const now = new Date()
  const summary: { id: string; name: string; city: string; legs: number; deposit: string; noShow: string }[] = []

  for (const spec of SPECS) {
    const merchantId = `mer_${spec.slug}`

    await db
      .insert(merchants)
      .values({
        merchantId,
        name: spec.name,
        // Cosmetic for now, and worth being honest about: every merchant in
        // this deployment transacts through the one Razorpay account whose
        // keys are in the environment. Per-merchant Razorpay accounts are a
        // real onboarding step (docs/01-architecture.md §10), not something a
        // seed script can conjure.
        razorpayAccountId: `acc_test_${spec.slug}`,
        createdAt: now,
      })
      .onConflictDoNothing()

    for (const [i, p] of spec.practitioners.entries()) {
      await db
        .insert(practitioners)
        .values({ practitionerId: `prac_${spec.slug}_${i + 1}`, merchantId, name: p.name, workingHours: p.hours, createdAt: now })
        .onConflictDoNothing()
    }

    for (const [i, s] of spec.services.entries()) {
      await db
        .insert(services)
        .values({ serviceId: `svc_${spec.slug}_${i + 1}`, merchantId, name: s.name, durationMinutes: s.minutes, pricePaise: s.pricePaise, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
    }

    await db
      .insert(policies)
      .values({
        policyId: `pol_${spec.slug}_v1`,
        merchantId,
        version: 1,
        depositType: 'fixed',
        depositAmountPaise: spec.depositPaise ?? null,
        cancellationLadder: spec.ladder,
        noShowFeePaise: spec.noShowPaise ?? null,
        // Paired with the fee, never independently set — the same rule
        // `validatePolicyInput` enforces on the write path.
        noShowGraceMinutes: spec.noShowPaise === undefined ? null : 15,
        holdTtlSeconds: spec.holdTtlSeconds,
        maxConcurrentHoldsPerAgent: 3,
        holdRateLimitPerMinute: 10,
        createdAt: now,
      })
      .onConflictDoNothing()

    summary.push({
      id: merchantId,
      name: spec.name,
      city: spec.city,
      legs: legCount(spec),
      deposit: spec.depositPaise === undefined ? '—' : `₹${spec.depositPaise / 100}`,
      noShow: spec.noShowPaise === undefined ? '—' : `₹${spec.noShowPaise / 100}`,
    })
  }

  const issued: { name: string; merchantApi: string; auditTrail: string }[] = []
  if (issueTokens) {
    const store = new PostgresMerchantAuthStore(db)
    for (const spec of SPECS) {
      const merchantId = `mer_${spec.slug}`
      const merchantApi = await store.issueToken(merchantId, 'merchant_api')
      const auditTrail = await store.issueToken(merchantId, 'audit_trail')
      issued.push({ name: spec.name, merchantApi: merchantApi.token, auditTrail: auditTrail.token })
    }
  }

  await sql.end()

  const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
  console.log(`\nseeded ${summary.length} merchants (idempotent — re-running changes nothing)\n`)
  console.log(`${pad('merchantId', 24)} ${pad('clinic', 34)} ${pad('city', 14)} legs  deposit  no-show`)
  console.log('-'.repeat(96))
  for (const r of summary) {
    console.log(`${pad(r.id, 24)} ${pad(r.name, 34)} ${pad(r.city, 14)}  ${r.legs}    ${pad(r.deposit, 8)} ${r.noShow}`)
  }

  const byLegs = summary.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.legs]: (acc[r.legs] ?? 0) + 1 }), {})
  console.log(`\npayment-leg mix: ${Object.entries(byLegs).map(([k, v]) => `${v} merchant(s) with ${k} leg(s)`).join(', ')}`)
  console.log('\nAn agent reaches any of them with no token and no onboarding:')
  console.log(`  POST /mcp/${summary[0]!.id}   ->  find_slots, get_policy, hold_slot, confirm_with_deposit`)

  if (issued.length > 0) {
    console.log('\n--- merchant credentials (printed once; only hashes are stored) ---')
    console.log('Re-running with --tokens ROTATES these: issueToken revokes the previous active credential.')
    for (const t of issued) {
      console.log(`\n${t.name}\n  merchant_api: ${t.merchantApi}\n  audit_trail:  ${t.auditTrail}`)
    }
  } else {
    console.log('\nNo credentials minted — the agent-facing MCP surface needs none.')
    console.log('Pass --tokens if you want merchant-api / audit-trail credentials for these merchants.')
  }
}

await seedMerchants()
