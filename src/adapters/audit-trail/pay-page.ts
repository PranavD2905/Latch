import type { PaymentRequestedLeg } from '../../domain/events.js'

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatRupees(amountPaise: number): string {
  return (amountPaise / 100).toFixed(2)
}

/** One leg as the page needs it: everything `renderPayPage` needs to render its row, live `done` status included. */
export interface PayPageLeg {
  leg: PaymentRequestedLeg['leg']
  label: string
  amountPaise: number
  orderId: string
  done: boolean
}

/**
 * Payment-link feature (dev-logs entry for this slice), rebuilt in the
 * follow-up to cover every applicable leg on **one** page instead of one
 * page per leg — the agent hands the human a single URL; this page renders
 * whichever legs apply (1, 2, or 3 — never a leg the merchant's policy
 * doesn't call for) and lets a human complete each Checkout invocation in
 * turn. `done` is a *live* read against Razorpay (`server.ts`'s route,
 * `pending-payment-status.ts`), not our own trail — the trail only records
 * a leg as captured/authorised once *every* applicable leg is done, in one
 * atomic finalize, so a leg can genuinely be "paid, as far as Razorpay is
 * concerned" before our own trail says so. A done leg renders as a fact,
 * not a button — reloading the page can never re-open Checkout against an
 * order that's already resolved.
 *
 * `keyId` is Razorpay's *publishable* key — safe to embed in a page; the
 * secret key never leaves the server (`RazorpayPaymentProvider`/
 * `ManualCaptureRail`, both adapters, both server-side only).
 *
 * `deposit` and `session_complete_authorization` don't use `keyId` for their
 * own forms (see `UPI_S2S_LEGS` below) — it's still the correct "is a real
 * provider actually wired up" signal, since a fake-provider setup has no
 * `keyId` either and the S2S submit route needs a real adapter exactly as
 * much as Checkout.js does. `no_show_authorization` is the one leg name that
 * still falls through to Checkout.js — dead going forward (the feature it
 * belonged to was removed; new bookings never carry it) but a booking that
 * was already `PENDING` on it before the removal could still exist.
 */
const UPI_S2S_LEGS: ReadonlySet<PaymentRequestedLeg['leg']> = new Set(['deposit', 'session_complete_authorization'])
export function renderPayPage(args: { bookingId: string; legs: readonly PayPageLeg[]; keyId: string | undefined; notice?: string }): string {
  const { bookingId, legs, keyId, notice } = args
  const allDone = legs.length > 0 && legs.every((l) => l.done)

  const rows = legs
    .map((leg) => {
      const amount = formatRupees(leg.amountPaise)
      if (leg.done) {
        return `
      <div class="leg done">
        <div class="leg-text">
          <p class="label">${escapeHtml(leg.label)}</p>
          <p class="amount">₹${escapeHtml(amount)}</p>
        </div>
        <span class="badge">✓ Done</span>
      </div>`
      }
      if (!keyId) {
        return `
      <div class="leg">
        <div class="leg-text">
          <p class="label">${escapeHtml(leg.label)}</p>
          <p class="amount">₹${escapeHtml(amount)}</p>
        </div>
        <span class="muted">test provider — no real Checkout</span>
      </div>`
      }
      if (UPI_S2S_LEGS.has(leg.leg)) {
        // UPI S2S collect (see `PaymentProvider.payDepositViaUpiCollect`/
        // `PaymentRail.authorizeViaUpiCollect`'s own doc comments) — a plain
        // server-rendered form, not Checkout.js. The VPA goes to our own
        // backend, which submits it to Razorpay server-to-server; no
        // publishable key or client script needed for either leg. Prefilled
        // with Razorpay's own test-mode magic VPA so a human only has to
        // click Pay — typing `failure@razorpay` instead demos the decline
        // path deliberately.
        return `
      <div class="leg">
        <div class="leg-text">
          <p class="label">${escapeHtml(leg.label)}</p>
          <p class="amount">₹${escapeHtml(amount)}</p>
        </div>
      </div>
      <form method="POST" action="/pay/${encodeURIComponent(bookingId)}/${leg.leg}" class="upi-form">
        <input type="text" name="vpa" value="success@razorpay" aria-label="UPI ID" required>
        <button type="submit">Pay</button>
      </form>`
      }
      const buttonId = `pay-${leg.leg}`
      const statusId = `status-${leg.leg}`
      return `
      <div class="leg">
        <div class="leg-text">
          <p class="label">${escapeHtml(leg.label)}</p>
          <p class="amount">₹${escapeHtml(amount)}</p>
        </div>
        <button id="${buttonId}">Pay</button>
      </div>
      <p id="${statusId}" class="muted status"></p>
      <script>
        document.getElementById(${JSON.stringify(buttonId)}).addEventListener('click', function () {
          var rzp = new Razorpay({
            key: ${JSON.stringify(keyId)},
            order_id: ${JSON.stringify(leg.orderId)},
            amount: ${leg.amountPaise},
            currency: 'INR',
            name: 'Latch',
            description: ${JSON.stringify(leg.label)},
            handler: function () {
              document.getElementById(${JSON.stringify(statusId)}).textContent = 'Received — reload this page to see it marked done.'
              document.getElementById(${JSON.stringify(buttonId)}).style.display = 'none'
            },
          })
          rzp.open()
        })
      </script>`
    })
    .join('\n')

  // Checkout.js only remains for the legacy no_show_authorization leg — every
  // leg new bookings can actually carry (deposit, session_complete_authorization)
  // uses the UPI S2S form above, so a normal booking's pay page makes no
  // cross-origin script load at all.
  const checkoutScript = legs.some((l) => !l.done && !UPI_S2S_LEGS.has(l.leg)) && keyId ? '<script src="https://checkout.razorpay.com/v1/checkout.js"></script>' : ''

  const noticeHtml = notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ''

  const footer = allDone
    ? `<p class="muted">Everything here is done. Let the assistant know you've paid.</p>`
    : `<p class="muted">Pay each one above, then tell the assistant you've paid.</p>`

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pay — Latch</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  .booking { color: #777; font-size: 0.85rem; margin-top: 0; margin-bottom: 2rem; }
  .leg { display: flex; align-items: center; justify-content: space-between; padding: 1rem 0; border-top: 1px solid #eee; }
  .leg.done { opacity: 0.6; }
  .leg-text { display: flex; flex-direction: column; }
  .label { margin: 0; color: #555; font-size: 0.9rem; }
  .amount { margin: 0.15rem 0 0; font-size: 1.4rem; font-weight: 600; }
  .badge { color: #1a7f37; font-weight: 600; font-size: 0.9rem; }
  .muted { color: #777; font-size: 0.85rem; }
  .status { margin-top: -0.5rem; margin-bottom: 0.5rem; }
  button { font-size: 0.95rem; padding: 0.5rem 1.25rem; border-radius: 6px; border: none; background: #1a1a1a; color: white; cursor: pointer; }
  button:hover { background: #333; }
  .upi-form { display: flex; gap: 0.5rem; padding-bottom: 1rem; border-top: none; margin-top: -0.5rem; }
  .upi-form input { flex: 1; font-size: 0.9rem; padding: 0.5rem 0.6rem; border-radius: 6px; border: 1px solid #ddd; }
  .notice { background: #fff3f3; border: 1px solid #f3c9c9; color: #a33; padding: 0.6rem 0.85rem; border-radius: 6px; font-size: 0.85rem; }
</style>
${checkoutScript}
</head>
<body>
  <h1>Latch</h1>
  <p class="booking">Booking ${escapeHtml(bookingId)}</p>
  ${noticeHtml}
  ${rows}
  ${footer}
</body>
</html>`
}

export function renderPayNotFoundPage(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Not found — Latch</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1.5rem;">
  <h1>Nothing to pay here</h1>
  <p>This link is for a booking that doesn't exist, or has nothing outstanding to pay.</p>
</body>
</html>`
}
