import { CircuitBreaker } from './circuit-breaker.js'
import { PaymentProviderError } from '../ports/payment-provider.js'
import { PaymentRailError } from '../ports/payment-rail.js'

/**
 * Wraps a real Razorpay-touching money-moving call (`captureDeposit`/
 * `authorize`/`captureAuthorization`/`refundDeposit`) in `deps.
 * paymentCircuitBreaker.execute` — dev-logs/020. If Razorpay is down, every
 * one of these currently times out at the adapter's own multi-minute
 * `captureTimeoutMs`/`authorizeTimeoutMs` (`razorpay-shared.ts`'s
 * `DEFAULT_CAPTURE_TIMEOUT_MS`), individually, per call, cascading into
 * MCP-side timeouts (dev-logs/012's own `mcp-remote` incident was a taste of
 * this from a different cause) — this makes a genuine outage fail fast with
 * `CircuitOpenError` instead.
 *
 * Only `PaymentProviderError`/`PaymentRailError` — "the call to the
 * provider itself failed unexpectedly" — count toward the breaker's failure
 * streak. Every other error these calls can throw (`PaymentDeclinedError`,
 * `PaymentTimeoutError`, `CaptureAmountMismatchError`,
 * `AuthorizationNotFoundError`) is an expected business/gate outcome, not a
 * sign Razorpay itself is unhealthy — a string of ordinary customer card
 * declines must never trip this breaker.
 */
export async function executePaymentCall<T>(breaker: CircuitBreaker, fn: () => Promise<T>): Promise<T> {
  return breaker.execute(fn, { isFailure: (err) => err instanceof PaymentProviderError || err instanceof PaymentRailError })
}
