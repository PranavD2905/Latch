import { ulid } from 'ulid'
import { isUniqueViolation } from '../adapters/db/postgres-errors.js'
import { createHoldCreatedEvent } from '../domain/event-factory.js'
import type { RefusalCode } from '../domain/refusals.js'
import { Refusal } from '../domain/refusals.js'
import type { BookingSnapshot } from '../ports/event-store.js'
import { UnknownPractitionerError, UnknownServiceError } from './find-slots.js'
import { NoActivePolicyError } from './get-policy.js'
import { appendRefusalEvent, refuseStandalone } from './refusal.js'
import type { AppDeps } from './types.js'

export interface HoldSlotCommand {
  agentId: string
  practitionerId: string
  serviceId: string
  /** The exact slot start time, as returned by `find_slots`. */
  startsAt: Date
  idempotencyKey: string
}

export interface HoldSlotResult {
  bookingId: string
  status: 'HELD'
  practitionerId: string
  serviceId: string
  startsAt: string
  holdExpiresAt: string
  ttlSeconds: number
}

type HoldOutcome = { kind: 'ok'; result: HoldSlotResult } | { kind: 'refused'; code: RefusalCode; reason: string }

/**
 * `hold_slot` — docs/01-architecture.md §3: moves NO money.
 *
 * Gate: slot free at request time — enforced by the DB partial unique
 * index, not app logic; we attempt the write and translate a constraint
 * violation into `SLOT_TAKEN`.
 *
 * Bound: max concurrent holds per agent, from policy. docs/01-architecture.md
 * §1 Idea 3 claims this bound is "Latch + DB constraint" — genuinely
 * unbreakable, the same tier as the slot-uniqueness index. A plain
 * count-then-insert would NOT deliver that (two concurrent calls from the
 * same agent can both read a count under the limit before either inserts),
 * so the count check and the insert both happen inside one transaction,
 * behind `tx.lockAgent(agentId)` — a Postgres advisory lock that serializes
 * every `hold_slot` call from the same agent. See dev-logs/004.
 */
export async function holdSlot(cmd: HoldSlotCommand, deps: AppDeps): Promise<HoldSlotResult> {
  const cached = await deps.idempotencyStore.get<HoldSlotResult>('hold_slot', cmd.idempotencyKey)
  if (cached) {
    return cached
  }

  const practitioner = await deps.catalogRepo.getPractitioner(cmd.practitionerId)
  if (!practitioner) {
    throw new UnknownPractitionerError(`unknown practitioner: ${cmd.practitionerId}`)
  }
  const service = await deps.catalogRepo.getService(cmd.serviceId)
  if (!service) {
    throw new UnknownServiceError(`unknown service: ${cmd.serviceId}`)
  }
  const policy = await deps.catalogRepo.getActivePolicy(deps.merchantId)
  if (!policy) {
    throw new NoActivePolicyError(`no active policy for merchant ${deps.merchantId}`)
  }

  const bookingId = `bkg_${ulid()}`
  const now = deps.clock.now()
  const holdExpiresAt = new Date(now.getTime() + policy.holdTtlSeconds * 1000)

  const projection: BookingSnapshot = {
    bookingId,
    practitionerId: cmd.practitionerId,
    serviceId: cmd.serviceId,
    startsAt: cmd.startsAt,
    status: 'HELD',
    policyVersion: undefined,
    authorizationId: undefined,
    authorizationAmountPaise: undefined,
    authorizationExpiresAt: undefined,
    authorizationLapsedAt: undefined,
    nonAttendanceMarkedAt: undefined,
    noShowEligibleMarkedAt: undefined,
    agentId: cmd.agentId,
    holdExpiresAt,
    lastEventSequence: 1,
  }

  let outcome: HoldOutcome
  try {
    outcome = await deps.eventStore.transaction<HoldOutcome>(async (tx) => {
      // Serializes concurrent hold_slot calls from this agent — see the
      // doc comment above. Held until this transaction commits or rolls back.
      await tx.lockAgent(cmd.agentId)

      const liveHolds = await tx.countLiveHoldsForAgent(cmd.agentId)
      if (liveHolds >= policy.maxConcurrentHoldsPerAgent) {
        const reason = `agent ${cmd.agentId} already has ${liveHolds} live hold(s), limit is ${policy.maxConcurrentHoldsPerAgent}`
        await appendRefusalEvent({
          tx,
          clock: deps.clock,
          bookingId,
          sequence: 1,
          attemptedType: 'hold_slot',
          code: 'HOLD_LIMIT_REACHED',
          reason,
          // No projection: this bookingId never became a live hold.
        })
        return { kind: 'refused', code: 'HOLD_LIMIT_REACHED', reason }
      }

      const event = createHoldCreatedEvent(bookingId, 1, deps.clock, {
        practitionerId: cmd.practitionerId,
        serviceId: cmd.serviceId,
        startsAt: cmd.startsAt,
        ttlSeconds: policy.holdTtlSeconds,
      })
      await tx.append([event], projection)

      const result: HoldSlotResult = {
        bookingId,
        status: 'HELD',
        practitionerId: cmd.practitionerId,
        serviceId: cmd.serviceId,
        startsAt: cmd.startsAt.toISOString(),
        holdExpiresAt: holdExpiresAt.toISOString(),
        ttlSeconds: policy.holdTtlSeconds,
      }
      return { kind: 'ok', result }
    })
  } catch (err) {
    if (isUniqueViolation(err, 'one_live_booking_per_slot')) {
      return refuseStandalone(deps, {
        attemptedType: 'hold_slot',
        code: 'SLOT_TAKEN',
        reason: `practitioner ${cmd.practitionerId} already has a live booking at ${cmd.startsAt.toISOString()}`,
      })
    }
    throw err
  }

  if (outcome.kind === 'refused') {
    throw new Refusal(outcome.code, outcome.reason)
  }

  await deps.idempotencyStore.put('hold_slot', cmd.idempotencyKey, outcome.result)
  return outcome.result
}
