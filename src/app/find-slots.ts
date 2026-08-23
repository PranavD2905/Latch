import { computeSlots } from '../domain/slots.js'
import type { AppDeps } from './types.js'

export interface FindSlotsCommand {
  practitionerId: string
  serviceId: string
  /** Days ahead to search, from the server clock's `now()`. Default 14. */
  days: number | undefined
}

export interface FindSlotsResult {
  practitionerId: string
  serviceId: string
  slots: readonly string[] // ISO datetime strings, ascending
}

export class UnknownPractitionerError extends Error {}
export class UnknownServiceError extends Error {}

/**
 * `find_slots` — computed live, docs/03-domain-model.md §1. No gate, no
 * bound, no money: this is the tool an agent can call as often as it wants.
 */
export async function findSlots(cmd: FindSlotsCommand, deps: AppDeps): Promise<FindSlotsResult> {
  const practitioner = await deps.catalogRepo.getPractitioner(cmd.practitionerId)
  if (!practitioner) {
    throw new UnknownPractitionerError(`unknown practitioner: ${cmd.practitionerId}`)
  }
  const service = await deps.catalogRepo.getService(cmd.serviceId)
  if (!service) {
    throw new UnknownServiceError(`unknown service: ${cmd.serviceId}`)
  }

  const now = deps.clock.now()
  const days = cmd.days ?? 14
  const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  const busyIntervals = await deps.eventStore.listLiveIntervals(cmd.practitionerId, now, to)

  const slots = computeSlots({
    workingHours: practitioner.workingHours,
    serviceDurationMinutes: service.durationMinutes,
    busyIntervals,
    from: now,
    days,
  })

  return {
    practitionerId: cmd.practitionerId,
    serviceId: cmd.serviceId,
    slots: slots.map((s) => s.toISOString()),
  }
}
