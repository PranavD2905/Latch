#!/usr/bin/env node
/**
 * slice-4.md item 7 — the pitch-video beat (2:00-2:45). Deliberately
 * requests a capture ₹0.01 above the authorised no-show amount and prints
 * the rail's own refusal. Trivially triggerable on demand:
 *
 *   npm run demo:ceiling-refusal                    # fresh booking, FakePaymentRail
 *   npm run demo:ceiling-refusal -- bkg_01J...       # against an existing CONFIRMED booking
 *   PAYMENT_PROVIDER=razorpay npm run demo:ceiling-refusal -- bkg_01J...
 *     # real Razorpay test mode — pass an existing bookingId whose deposit
 *     # AND no-show authorisation were already confirmed via real Checkout
 *     # (dev-logs/006/007: a fresh booking needs a human at Checkout twice,
 *     # which this script cannot drive unattended)
 */
import { ulid } from 'ulid'
import { confirmWithDeposit } from '../../app/confirm-with-deposit.js'
import { demoCeilingRefusal } from '../../app/demo-ceiling-refusal.js'
import { findSlots } from '../../app/find-slots.js'
import { getPolicy } from '../../app/get-policy.js'
import { holdSlot } from '../../app/hold-slot.js'
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { createDbClient } from '../db/client.js'
import { SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../db/seed-data.js'

process.loadEnvFile?.('.env')

const { db } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db)

async function freshConfirmedBooking(): Promise<string> {
  const found = await findSlots({ practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, days: 5 }, deps)
  const startsAt = found.slots[0]
  if (!startsAt) {
    throw new Error('no free slots within the 5-day authorisation window right now — try again shortly, or pass an existing bookingId')
  }
  const agentId = `agent_demo_${ulid()}`
  const held = await holdSlot(
    { agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt: new Date(startsAt), idempotencyKey: `demo_hold_${ulid()}` },
    deps,
  )
  const policyResult = await getPolicy(deps)
  const confirmed = await confirmWithDeposit(
    { bookingId: held.bookingId, agentId, acknowledgedPolicyVersion: policyResult.policy.policyVersion, idempotencyKey: `demo_confirm_${ulid()}` },
    deps,
  )
  return confirmed.bookingId
}

const bookingId = process.argv[2] ?? (await freshConfirmedBooking())
console.log(`\nDemonstrating the ceiling refusal against booking ${bookingId} (rail: ${deps.paymentRail.name})...\n`)

const result = await demoCeilingRefusal(bookingId, deps)

console.log(`Authorised amount:    ₹${(result.authorizedAmountPaise / 100).toFixed(2)}`)
console.log(`Attempted capture:    ₹${(result.attemptedAmountPaise / 100).toFixed(2)}`)
console.log(`Refused: "${result.railMessage}"`)
console.log(`Mapped to refusal code: ${result.refusalCode}`)
console.log(`Recorded in the trail as ACTION_REFUSED, enforcedBy: payment_rail.\n`)

process.exit(0)
