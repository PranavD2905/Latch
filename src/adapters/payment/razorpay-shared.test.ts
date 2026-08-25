import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isNotFound, receiptFor, toPaymentStatusValue, verifyRazorpayWebhookSignature } from './razorpay-shared.js'

describe('verifyRazorpayWebhookSignature — dev-logs/014 item 2, security-critical', () => {
  const secret = 'whsec_test'
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: {} }))

  it('accepts a signature computed the way Razorpay documents (HMAC-SHA256 hex of the raw body)', () => {
    const signature = createHmac('sha256', secret).update(body).digest('hex')
    expect(verifyRazorpayWebhookSignature(body, signature, secret)).toBe(true)
  })

  it('rejects a signature computed with the wrong secret', () => {
    const signature = createHmac('sha256', 'a-different-secret').update(body).digest('hex')
    expect(verifyRazorpayWebhookSignature(body, signature, secret)).toBe(false)
  })

  it('rejects a signature computed over a different body — catches a tampered payload', () => {
    const signature = createHmac('sha256', secret).update(Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { tampered: true } }))).digest('hex')
    expect(verifyRazorpayWebhookSignature(body, signature, secret)).toBe(false)
  })

  it('rejects garbage / mismatched-length signatures without throwing', () => {
    expect(verifyRazorpayWebhookSignature(body, 'not-a-real-signature', secret)).toBe(false)
    expect(verifyRazorpayWebhookSignature(body, '', secret)).toBe(false)
  })
})

describe('toPaymentStatusValue — the reconciliation worker/webhook vocabulary', () => {
  it('passes through every status this codebase ever puts a payment into', () => {
    expect(toPaymentStatusValue('created')).toBe('created')
    expect(toPaymentStatusValue('authorized')).toBe('authorized')
    expect(toPaymentStatusValue('captured')).toBe('captured')
    expect(toPaymentStatusValue('refunded')).toBe('refunded')
    expect(toPaymentStatusValue('failed')).toBe('failed')
  })

  it('maps anything unrecognised to unknown rather than throwing', () => {
    expect(toPaymentStatusValue('pending')).toBe('unknown')
    expect(toPaymentStatusValue('')).toBe('unknown')
  })
})

describe('isNotFound', () => {
  it('recognises Razorpay\'s "does not exist" shape', () => {
    expect(isNotFound({ error: { description: 'The id provided does not exist' } })).toBe(true)
  })
  it('does not misclassify an unrelated error', () => {
    expect(isNotFound({ error: { description: 'Capture amount must be equal to the amount authorized' } })).toBe(false)
    expect(isNotFound(new Error('network error'))).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
  })
})

describe('receiptFor — unaffected by this slice, guarded against regression', () => {
  it('passes through a short, safe key unchanged', () => {
    expect(receiptFor('abc-123')).toBe('abc-123')
  })
})
