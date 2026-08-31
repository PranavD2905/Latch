import { describe, expect, it } from 'vitest'
import { renderPayNotFoundPage, renderPayPage, type PayPageLeg } from './pay-page.js'

/**
 * Payment-link feature follow-up (dev-logs entry): one page covers every
 * applicable leg. These pin the two properties that actually matter for
 * safety — a done leg never renders a Pay button (so reloading can't
 * re-open Checkout against an already-resolved order), and the page never
 * renders a leg the merchant's policy didn't ask for — plus the plain
 * rendering of 1, 2, and 3 legs.
 */

const KEY_ID = 'rzp_test_fake'

function leg(overrides: Partial<PayPageLeg> = {}): PayPageLeg {
  return { leg: 'deposit', label: '₹300 deposit for your booking', amountPaise: 30000, orderId: 'order_dep', done: false, ...overrides }
}

describe('renderPayPage', () => {
  it('renders all three legs on one page, each with its own Pay button', () => {
    const html = renderPayPage({
      bookingId: 'bkg_1',
      legs: [
        leg(),
        leg({ leg: 'no_show_authorization', label: '₹400 no-show hold', amountPaise: 40000, orderId: 'order_ns' }),
        leg({ leg: 'session_complete_authorization', label: '₹500 remaining-balance hold', amountPaise: 50000, orderId: 'order_sc' }),
      ],
      keyId: KEY_ID,
    })
    // The deposit leg's orderId is deliberately never sent to the browser —
    // its S2S form only carries a VPA; the server re-resolves the order from
    // `pendingPaymentLegs` itself (server.ts's POST route). Only the two
    // Checkout.js legs still need their orderId client-side.
    expect(html).not.toContain('order_dep')
    expect(html).toContain('order_ns')
    expect(html).toContain('order_sc')
    expect(html.match(/<button /g)).toHaveLength(3)
    expect(html).toContain('checkout.razorpay.com')
  })

  it('renders a single-leg page for a merchant whose policy asks for only one leg', () => {
    const html = renderPayPage({ bookingId: 'bkg_2', legs: [leg({ leg: 'session_complete_authorization', label: '₹800 balance hold', orderId: 'order_only' })], keyId: KEY_ID })
    expect(html.match(/<button /g)).toHaveLength(1)
    expect(html).toContain('order_only')
    expect(html).not.toContain('order_dep')
  })

  it('a done leg renders as a fact, never as a re-clickable Pay button — reloading cannot re-pay it', () => {
    const html = renderPayPage({
      bookingId: 'bkg_3',
      legs: [leg({ done: true }), leg({ leg: 'no_show_authorization', label: '₹400 no-show hold', orderId: 'order_ns' })],
      keyId: KEY_ID,
    })
    expect(html.match(/<button /g)).toHaveLength(1) // only the outstanding one
    expect(html).toContain('✓ Done')
    // The done leg's order id never reaches a Checkout invocation on this page.
    expect(html).not.toMatch(/order_id:\s*"order_dep"/)
    expect(html).toMatch(/order_id:\s*"order_ns"/)
  })

  it('renders no Pay buttons and loads no Checkout script once every leg is done', () => {
    const html = renderPayPage({ bookingId: 'bkg_4', legs: [leg({ done: true }), leg({ leg: 'no_show_authorization', orderId: 'order_ns', done: true })], keyId: KEY_ID })
    expect(html).not.toContain('<button ')
    expect(html).not.toContain('checkout.razorpay.com')
    expect(html).toContain("Everything here is done")
  })

  it('escapes booking ids and labels rather than interpolating them raw', () => {
    const html = renderPayPage({ bookingId: '<script>x</script>', legs: [leg({ label: '<b>bold</b>' })], keyId: KEY_ID })
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;')
  })

  it('says so plainly when running against the in-memory test provider (no publishable key)', () => {
    const html = renderPayPage({ bookingId: 'bkg_5', legs: [leg()], keyId: undefined })
    expect(html).not.toContain('<button ')
    expect(html).toContain('test provider')
  })

  it('the deposit leg gets a plain VPA form, not a Checkout.js button — no publishable key needed for it', () => {
    const html = renderPayPage({ bookingId: 'bkg_6', legs: [leg()], keyId: 'rzp_test_fake' })
    expect(html).toContain('<form method="POST" action="/pay/bkg_6/deposit"')
    expect(html).toContain('name="vpa"')
    expect(html).toContain('value="success@razorpay"')
    expect(html).not.toContain('checkout.razorpay.com')
    expect(html).not.toMatch(/new Razorpay\(/)
  })

  it('a booking with only authorisation legs outstanding still loads Checkout.js', () => {
    const html = renderPayPage({ bookingId: 'bkg_7', legs: [leg({ leg: 'no_show_authorization', orderId: 'order_ns' })], keyId: 'rzp_test_fake' })
    expect(html).toContain('checkout.razorpay.com')
  })

  it('shows a notice banner when one is passed (e.g. after a declined UPI attempt)', () => {
    const html = renderPayPage({ bookingId: 'bkg_8', legs: [leg()], keyId: 'rzp_test_fake', notice: 'That payment was declined.' })
    expect(html).toContain('That payment was declined.')
  })

  it('escapes a notice rather than interpolating it raw', () => {
    const html = renderPayPage({ bookingId: 'bkg_9', legs: [leg()], keyId: 'rzp_test_fake', notice: '<script>x</script>' })
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('renderPayNotFoundPage', () => {
  it('says nothing is outstanding without leaking whether the booking exists', () => {
    const html = renderPayNotFoundPage()
    expect(html).toContain('Nothing to pay here')
  })
})
