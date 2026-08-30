import type { ConfirmWithDepositResult } from './confirm-with-deposit.js'

/**
 * `ConfirmWithDepositResult` is a discriminated union (payment-link feature,
 * dev-logs entry for this slice) — a test asserting the happy path narrows
 * with this rather than repeating the same `if (result.status !== 'CONFIRMED')
 * throw ...` at every call site across the integration suite.
 */
export function requireConfirmed(result: ConfirmWithDepositResult): Extract<ConfirmWithDepositResult, { status: 'CONFIRMED' }> {
  if (result.status !== 'CONFIRMED') {
    throw new Error(`expected confirm_with_deposit to return CONFIRMED, got ${result.status} — outstanding: ${JSON.stringify(result.outstanding)}`)
  }
  return result
}
