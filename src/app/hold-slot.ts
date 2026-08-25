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

const IDEMPOTENCY_CLAIM_TIMEOUT_MS = 30_000

/**
 * dev-logs/014, gap 2: the window `policy.holdRateLimitPerMinute` is measured
 * over. A fixed 60s lookback rather than a true sliding/leaky bucket — the
 * simplest thing that is still a real, DB-verified ceiling rather than an
 * in-memory guess, and correctly survives this process restarting (unlike an
 * in-memory counter, which single-instance deployment would otherwise make
 * tempting — docs/07-deployment.md's single-instance shape is exactly why an
 * in-memory limiter would have been defensible, but a real one was cheap
 * enough not to need that excuse).
 */
const RATE_LIMIT_WINDOW_MS = 60_000

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
  const claim = await deps.idempotencyStore.claim<HoldSlotResult>('hold_slot', cmd.idempotencyKey, {
    timeoutMs: deps.idempotencyClaimTimeoutMs ?? IDEMPOTENCY_CLAIM_TIMEOUT_MS,
  })
  if (claim.kind === 'completed') {
    return claim.response
  }
  if (claim.kind === 'timed_out') {
    return refuseStandalone(deps, {
      attemptedType: 'hold_slot',
      code: 'IDEMPOTENT_REPLAY',
      reason: `a hold_slot request with idempotency key ${cmd.idempotencyKey} is already in progress and did not complete in time`,
    })
  }

  try {
    return await holdSlotClaimed(cmd, deps)
  } catch (err) {
    await deps.idempotencyStore.release('hold_slot', cmd.idempotencyKey)
    throw err
  }
}

async function holdSlotClaimed(cmd: HoldSlotCommand, deps: AppDeps): Promise<HoldSlotResult> {
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

      // dev-logs/014, gap 2: bounds *rate*, not just concurrent count — a
      // hostile agent sitting at the concurrent-hold ceiling and
      // re-holding as fast as TTLs lapse passes the check above every
      // single time while still locking out legitimate agents, with zero
      // money moved and therefore zero payment trail. Checked inside the
      // same `lockAgent` transaction, so the two bounds are atomic against
      // the same serialised window per agent — no separate race to close.
      const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS)
      const recentHolds = await tx.countBookingsCreatedByAgentSince(cmd.agentId, windowStart)
      if (recentHolds >= policy.holdRateLimitPerMinute) {
        const reason = `agent ${cmd.agentId} created ${recentHolds} booking(s) in the last ${RATE_LIMIT_WINDOW_MS / 1000}s, limit is ${policy.holdRateLimitPerMinute}/min`
        await appendRefusalEvent({
          tx,
          clock: deps.clock,
          bookingId,
          sequence: 1,
          attemptedType: 'hold_slot',
          code: 'RATE_LIMITED',
          reason,
          // No projection: this bookingId never became a live hold.
        })
        return { kind: 'refused', code: 'RATE_LIMITED', reason }
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
