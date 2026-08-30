import type { WebhookDeadLetterRecord, WebhookDeadLetterStore } from '../../ports/webhook-dead-letter-store.js'

/** `WebhookDeadLetterStore`'s in-memory test double — same role as this file's siblings (docs/02-tech-stack.md §13). */
export class FakeWebhookDeadLetterStore implements WebhookDeadLetterStore {
  private readonly rows = new Map<string, WebhookDeadLetterRecord>()

  async recordFailure(params: {
    idempotencyKey: string
    event: string
    entityId: string
    payload: unknown
    error: string
    now: Date
    maxAttempts: number
  }): Promise<WebhookDeadLetterRecord> {
    const existing = this.rows.get(params.idempotencyKey)
    const attemptCount = (existing?.attemptCount ?? 0) + 1
    const record: WebhookDeadLetterRecord = {
      idempotencyKey: params.idempotencyKey,
      event: params.event,
      entityId: params.entityId,
      payload: params.payload,
      lastError: params.error,
      attemptCount,
      firstFailedAt: existing?.firstFailedAt ?? params.now,
      lastFailedAt: params.now,
      deadLetteredAt: existing?.deadLetteredAt ?? (attemptCount >= params.maxAttempts ? params.now : null),
    }
    this.rows.set(params.idempotencyKey, record)
    return record
  }
}
