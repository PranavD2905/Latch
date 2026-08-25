import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbClient } from './client.js'
import { bookings, merchants, policies, practitioners, services } from './schema.js'
import { deletePoliciesForTest } from './policy-test-cleanup.js'

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const merchantId = `mer_${ulid()}`
const practitionerId = `prac_${ulid()}`
const serviceId = `svc_${ulid()}`

function newBooking(overrides: { startsAt: Date; status: 'held' | 'confirmed' }) {
  return {
    bookingId: `bkg_${ulid()}`,
    practitionerId,
    serviceId,
    startsAt: overrides.startsAt,
    status: overrides.status,
    lastEventSequence: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

beforeAll(async () => {
  await db.insert(merchants).values({
    merchantId,
    name: 'Test Dermatology Clinic',
    razorpayAccountId: 'acc_test',
    createdAt: new Date(),
  })
  await db.insert(practitioners).values({
    practitionerId,
    merchantId,
    name: 'Dr. Rao',
    workingHours: { mon: [['09:00', '13:00']] },
    createdAt: new Date(),
  })
  await db.insert(services).values({
    serviceId,
    merchantId,
    name: 'Dermatology consult',
    durationMinutes: 30,
    pricePaise: 80000,
    createdAt: new Date(),
  })
})

afterAll(async () => {
  await deletePoliciesForTest(db, eq(policies.merchantId, merchantId))
  await db.delete(bookings).where(eq(bookings.practitionerId, practitionerId))
  await db.delete(services).where(eq(services.serviceId, serviceId))
  await db.delete(practitioners).where(eq(practitioners.practitionerId, practitionerId))
  await db.delete(merchants).where(eq(merchants.merchantId, merchantId))
  await sql.end()
})

describe('one_live_booking_per_slot (raw DB, not application logic)', () => {
  it('allows one live booking for a practitioner+slot', async () => {
    const startsAt = new Date('2026-09-03T10:30:00+05:30')
    await expect(db.insert(bookings).values(newBooking({ startsAt, status: 'held' }))).resolves.not.toThrow()
  })

  it('rejects a second concurrent live booking for the same practitioner+slot', async () => {
    const startsAt = new Date('2026-09-03T11:30:00+05:30')
    await db.insert(bookings).values(newBooking({ startsAt, status: 'held' }))

    // Same practitioner, same instant, still "held" — this is exactly the race
    // from docs/01-architecture.md §4: two agents landing on the same slot.
    await expect(db.insert(bookings).values(newBooking({ startsAt, status: 'confirmed' }))).rejects.toThrow(
      /one_live_booking_per_slot|duplicate key value/i,
    )
  })

  it('permits a new live booking once the earlier one is no longer live', async () => {
    const startsAt = new Date('2026-09-03T12:30:00+05:30')
    const first = newBooking({ startsAt, status: 'held' })
    await db.insert(bookings).values(first)

    // The projection's status changes via UPDATE, in the same transaction as
    // the causing event in real usage — see docs/03-domain-model.md §1.
    await db.update(bookings).set({ status: 'cancelled_by_customer', updatedAt: new Date() }).where(eq(bookings.bookingId, first.bookingId))

    // The slot is no longer "live" (status outside held/confirmed), so the
    // partial index does not apply to the cancelled row — a fresh booking succeeds.
    await expect(db.insert(bookings).values(newBooking({ startsAt, status: 'held' }))).resolves.not.toThrow()
  })
})

describe('policies_immutable (raw DB, not application logic)', () => {
  // Migration 0010. Every money event cites `authority.policyVersion`, so a
  // policy row is a historical fact the audit trail resolves against — not a
  // config record. Mutating one would make already-settled events cite an
  // authority that no longer says what it said: the trail would lie rather
  // than merely go stale. Deleting one breaks the authority chain outright.
  //
  // publishPolicy() already only ever INSERTs. This proves the guarantee holds
  // at the database, so it survives a future code path that forgets — the same
  // move as one_live_booking_per_slot above.
  const policyRow = (version: number) => ({
    policyId: `pol_${ulid()}`,
    merchantId,
    version,
    depositType: 'fixed',
    depositAmountPaise: 30000,
    cancellationLadder: [
      { hoursBefore: 48, retainPct: 0 },
      { hoursBefore: 12, retainPct: 50 },
      { hoursBefore: 0, retainPct: 100 },
    ],
    noShowFeePaise: 40000,
    noShowGraceMinutes: 15,
    holdTtlSeconds: 600,
    maxConcurrentHoldsPerAgent: 3,
    holdRateLimitPerMinute: 10,
    createdAt: new Date(),
  })

  it('allows INSERT — publishing a new version is the only legal write', async () => {
    await expect(db.insert(policies).values(policyRow(1))).resolves.not.toThrow()
  })

  it('rejects UPDATE of a published policy', async () => {
    await db.insert(policies).values(policyRow(2))
    await expect(
      db.update(policies).set({ noShowFeePaise: 999999 }).where(eq(policies.merchantId, merchantId)),
    ).rejects.toThrow(/append-only/i)
  })

  it('rejects DELETE of a published policy', async () => {
    await db.insert(policies).values(policyRow(3))
    await expect(db.delete(policies).where(eq(policies.merchantId, merchantId))).rejects.toThrow(/append-only/i)
  })

  it('honours the transaction-local escape hatch, and does not leak it to the next statement', async () => {
    await db.insert(policies).values(policyRow(4))

    // deletePoliciesForTest sets `latch.allow_policy_mutation` with SET LOCAL.
    // Scoped to THIS test's merchant. A bare `eq(policies.version, 4)` would
    // delete every merchant's v4 — including the seed clinic's active policy.
    await expect(
      deletePoliciesForTest(db, and(eq(policies.merchantId, merchantId), eq(policies.version, 4))!),
    ).resolves.not.toThrow()

    // The critical half: `LOCAL` scopes it to that transaction, so the pooled
    // connection it borrowed must come back guarded. Without this, one cleanup
    // would silently disarm the trigger for whatever ran next.
    await db.insert(policies).values(policyRow(5))
    await expect(
      db.delete(policies).where(and(eq(policies.merchantId, merchantId), eq(policies.version, 5))),
    ).rejects.toThrow(/append-only/i)
  })
})
