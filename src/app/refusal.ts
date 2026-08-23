import { ulid } from 'ulid'
import { createActionRefusedEvent } from '../domain/event-factory.js'
import { Refusal, type RefusalCode } from '../domain/refusals.js'
import type { BookingSnapshot, EventStoreTx } from '../ports/event-store.js'
import type { AppDeps } from './types.js'

/**
 * Appends an `ACTION_REFUSED` event *inside an already-open transaction*.
 * docs/03-domain-model.md §4 footnote ★★: refusals are events too. Does
 * NOT throw — the caller's transaction callback must return normally so the
 * event actually commits; throwing here would roll back the very record
 * we're trying to keep. The caller inspects the returned outcome and throws
 * `Refusal` itself, once the transaction has committed.
 */
export async function appendRefusalEvent(params: {
  tx: EventStoreTx
  clock: AppDeps['clock']
  bookingId: string
  sequence: number
  attemptedType: string
  code: RefusalCode
  reason: string
  /** Pass the current snapshot (with `lastEventSequence` bumped) to keep the projection's sequence in sync; omit for a refusal with no live booking. */
  projection?: BookingSnapshot
}): Promise<void> {
  const event = createActionRefusedEvent(params.bookingId, params.sequence, params.clock, {
    attemptedType: params.attemptedType,
    refusalCode: params.code,
    reason: params.reason,
  })
  await params.tx.append([event], params.projection)
}

/**
 * For a refusal with no existing booking to lock (e.g. `hold_slot` refused
 * before any hold exists) — opens its own transaction, records the refusal
 * against a fresh, ephemeral bookingId (never given a `bookings` projection
 * row), then throws `Refusal` once that transaction has committed.
 */
export async function refuseStandalone(deps: AppDeps, params: { attemptedType: string; code: RefusalCode; reason: string }): Promise<never> {
  const bookingId = `bkg_${ulid()}`
  await deps.eventStore.transaction(async (tx) => {
    await appendRefusalEvent({
      tx,
      clock: deps.clock,
      bookingId,
      sequence: 1,
      attemptedType: params.attemptedType,
      code: params.code,
      reason: params.reason,
    })
  })
  throw new Refusal(params.code, params.reason)
}
