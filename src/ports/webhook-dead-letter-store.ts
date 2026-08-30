/**
 * dev-logs/016: `POST /webhooks/razorpay` (dev-logs/014) already retries
 * safely — Razorpay redelivers anything but a 2xx, and the idempotency
 * claim (`IdempotencyStore`) makes a redelivery a safe replay, not a
 * double-append. What it had no answer for is a delivery that fails
 * *deterministically* — a bug in this handler, a booking whose order was
 * deleted, a permanently malformed payload — where every redelivery just
 * fails the same way forever, invisibly, with nothing to show for it but a
 * climbing count in Razorpay's own dashboard.
 *
 * This store is where a webhook delivery's failure history lives once it's
 * failed enough consecutive times (`app/webhook-dead-letter.ts`'s
 * `WEBHOOK_MAX_ATTEMPTS`) that another Razorpay-driven redelivery is very
 * unlikely to be the fix — a human needs to look at it.
 */
export interface WebhookDeadLetterRecord {
  idempotencyKey: string
  event: string
  entityId: string
  payload: unknown
  lastError: string
  attemptCount: number
  firstFailedAt: Date
  lastFailedAt: Date
  /** Set once `attemptCount` reaches the threshold — this delivery has stopped being retried. Null while still within budget. */
  deadLetteredAt: Date | null
}

export interface WebhookDeadLetterStore {
  /**
   * Upserts on `idempotencyKey`: increments `attemptCount`, records the
   * latest error, and sets `deadLetteredAt` (once, never overwritten) the
   * first time `attemptCount` reaches `maxAttempts`. Returns the row after
   * the write so the caller knows, without a second read, whether this
   * specific call is the one that crossed the threshold.
   */
  recordFailure(params: { idempotencyKey: string; event: string; entityId: string; payload: unknown; error: string; now: Date; maxAttempts: number }): Promise<WebhookDeadLetterRecord>
}
