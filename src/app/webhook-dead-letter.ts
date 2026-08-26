import type { AppDeps } from './types.js'

/**
 * dev-logs/016. Razorpay itself spaces webhook redeliveries out over hours
 * (its own documented backoff schedule), so 5 consecutive failures already
 * represents a delivery that has been wrong across a meaningful span of
 * real time, not five rapid-fire attempts a transient blip could explain.
 * Named here, not left as a magic number in the route handler.
 */
export const WEBHOOK_MAX_ATTEMPTS = 5

export interface RecordWebhookFailureParams {
  event: string
  entityId: string
  payload: unknown
  error: unknown
}

/**
 * Called from `POST /webhooks/razorpay`'s catch block once a delivery's
 * processing has thrown. Returns whether *this* failure is the one that
 * crossed `WEBHOOK_MAX_ATTEMPTS` — the route uses that to decide whether to
 * keep telling Razorpay to retry (still under budget: a normal 5xx, so
 * Razorpay's own redelivery keeps working the problem) or to stop asking
 * (`deadLettered: true` — a human needs to look at this, not have Razorpay
 * hammer it forever).
 */
export async function recordWebhookFailure(idempotencyKey: string, params: RecordWebhookFailureParams, deps: AppDeps): Promise<{ deadLettered: boolean; attemptCount: number }> {
  const record = await deps.webhookDeadLetterStore.recordFailure({
    idempotencyKey,
    event: params.event,
    entityId: params.entityId,
    payload: params.payload,
    error: params.error instanceof Error ? params.error.message : String(params.error),
    now: deps.clock.now(),
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
  })

  if (record.deadLetteredAt) {
    // Loud on purpose — this is the one thing about this failure that
    // nothing else in the system will otherwise surface (dev-logs/014's own
    // "report, don't auto-repair" posture, applied to the webhook's own
    // delivery health rather than a payment mismatch).
    console.error(`webhook dead-lettered after ${record.attemptCount} attempts: ${record.event} ${record.entityId} — last error: ${record.lastError}`)
  }

  return { deadLettered: record.deadLetteredAt !== null, attemptCount: record.attemptCount }
}
