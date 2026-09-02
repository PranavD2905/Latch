#!/usr/bin/env node
/**
 * The video-beat script, live-Razorpay variant (docs/06-build-sequence.md
 * beat 2:00-2:45 / this repo's `demo-ceiling-refusal.ts`, same claim). That
 * script drives the full app and, against real Razorpay, needs a bookingId
 * whose session-complete mandate a human already authorised via Checkout
 * (dev-logs/006/007's account-permission gate — cards can't be authorised
 * headlessly). This script sidesteps that entirely for the one leg that
 * doesn't need it: it authorises via real UPI collect S2S against Razorpay's
 * magic test VPA `success@razorpay` — the exact mechanism
 * `manual-capture-rail.live.integration.test.ts` verifies live — so the
 * whole sequence runs with zero human interaction, in a few seconds, against
 * the real API, not a mock.
 *
 * Deliberately talks to the raw Razorpay SDK directly rather than going
 * through `ManualCaptureRail` — that adapter catches Razorpay's raw error
 * and re-throws Latch's own `CaptureAmountMismatchError` (a clean type for
 * the domain to catch), which is correct there but means the on-screen text
 * would be *our* wrapper's message, not Razorpay's. This script prints the
 * raw, unedited `{ statusCode, error: { code, description } }` object the
 * SDK actually throws, which is the shot the video wants at 2:05-2:30.
 *
 *   npm run demo:ceiling-refusal:live
 *
 * Needs RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env (test mode).
 */
import Razorpay from 'razorpay'

process.loadEnvFile?.('.env')

const keyId = process.env['RAZORPAY_KEY_ID']
const keySecret = process.env['RAZORPAY_KEY_SECRET']
if (!keyId || !keySecret) {
  throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set in .env')
}

const client = new Razorpay({ key_id: keyId, key_secret: keySecret })

const AUTHORIZED_AMOUNT_PAISE = 50_000 // ₹500 — stands in for a session-complete mandate
const OVER_CEILING_AMOUNT_PAISE = AUTHORIZED_AMOUNT_PAISE + 1 // one paisa above the ceiling
const S2S_EMAIL = 'payer@latch.test'
const S2S_CONTACT = '9999999999'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

console.log('\n1. Placing a card-manual-capture authorisation for ₹500.00 — the session-complete mandate...\n')

const order = await client.orders.create({
  amount: AUTHORIZED_AMOUNT_PAISE,
  currency: 'INR',
  receipt: `demo_ceiling_live_${Date.now()}`,
  payment: {
    capture: 'manual',
    capture_options: {
      automatic_expiry_period: 12, // required by the SDK type, unused in manual mode
      manual_expiry_period: 7200, // Razorpay's own maximum — 5 days
      refund_speed: 'normal',
    },
  },
})
console.log(`   order created: ${order.id}`)

console.log(`\n2. Authorising it — real UPI collect, real Razorpay API, zero human involved (vpa: success@razorpay)...\n`)

await client.payments.createUpi({
  amount: AUTHORIZED_AMOUNT_PAISE,
  currency: 'INR',
  order_id: order.id,
  email: S2S_EMAIL,
  contact: S2S_CONTACT,
  method: 'upi',
  vpa: 'success@razorpay',
} as unknown as Parameters<Razorpay['payments']['createUpi']>[0])

let authorizedPaymentId: string | undefined
const deadline = Date.now() + 8_000
while (!authorizedPaymentId && Date.now() < deadline) {
  const payments = await client.orders.fetchPayments(order.id)
  const latest = payments.items[payments.items.length - 1]
  if (latest?.status === 'authorized') {
    authorizedPaymentId = latest.id
    break
  }
  await sleep(500)
}
if (!authorizedPaymentId) {
  throw new Error('authorization did not land as `authorized` within 8s — check the order in the Razorpay test dashboard')
}
console.log(`   authorised: ${authorizedPaymentId} — held at exactly ₹${(AUTHORIZED_AMOUNT_PAISE / 100).toFixed(2)}, not one rupee more.\n`)

console.log(`3. Now the beat: asking Razorpay to capture ₹${(OVER_CEILING_AMOUNT_PAISE / 100).toFixed(2)} — one paisa above what was authorised...\n`)

try {
  await client.payments.capture(authorizedPaymentId, OVER_CEILING_AMOUNT_PAISE, 'INR')
  // Only reachable if Razorpay accepted an over-ceiling capture — the
  // opposite of what this script exists to demonstrate.
  throw new Error('demo invariant violated: Razorpay accepted a capture above the authorised amount')
} catch (err) {
  console.log('   RAZORPAY REFUSED IT. Raw response, unedited:\n')
  console.log(JSON.stringify(err, null, 2))
  console.log('\n   This is not our code catching a mistake. This is the payment rail, at the API boundary,')
  console.log('   refusing to move a rupee we did not have standing authorisation for.\n')
}

console.log(`4. Closing it out cleanly — capturing the correct, authorised amount instead...\n`)
const captured = await client.payments.capture(authorizedPaymentId, AUTHORIZED_AMOUNT_PAISE, 'INR')
console.log(`   captured: ${captured.id} for ₹${(Number(captured.amount) / 100).toFixed(2)}. Demo left in a clean state.\n`)
