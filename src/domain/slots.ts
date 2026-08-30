/**
 * Slot computation. docs/03-domain-model.md §1: "There is no `Slot` table.
 * Slots are computed — a practitioner's working hours, minus a service's
 * duration, minus existing live bookings." This module is that computation,
 * pure and DB-free: the caller (an app-layer handler, via a repo port)
 * supplies working hours and already-loaded busy intervals; this function
 * never touches I/O or the clock.
 *
 * All wall-clock times are IST (Asia/Kolkata, a fixed UTC+05:30 offset with
 * no DST) per docs/02-tech-stack.md §15 ("date-fns + explicit IST handling").
 */

const IST_OFFSET_MINUTES = 5 * 60 + 30
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000

/** mon/tue/wed/thu/fri/sat/sun -> ordered list of [startHHmm, endHHmm) windows, IST. */
export type WorkingHours = Partial<Record<DayKey, readonly [string, string][]>>

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type DayKey = (typeof DAY_KEYS)[number]

export interface BusyInterval {
  startsAt: Date
  endsAt: Date
}

export interface ComputeSlotsParams {
  workingHours: WorkingHours
  serviceDurationMinutes: number
  /** Existing live (held/confirmed) bookings that block candidate slots. */
  busyIntervals: readonly BusyInterval[]
  /** Only slots from this instant forward are returned — this is `clock.now()`, never a client-supplied value. */
  from: Date
  /** How many calendar days ahead (in IST) to search, starting from `from`'s IST calendar day. */
  days: number
  /** Grid step between candidate slot starts, in minutes. Defaults to the service duration (back-to-back slots). */
  stepMinutes?: number
}

function istParts(date: Date): { year: number; month: number; date: number; dayOfWeek: number } {
  const ist = new Date(date.getTime() + IST_OFFSET_MS)
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth(),
    date: ist.getUTCDate(),
    dayOfWeek: ist.getUTCDay(),
  }
}

/** Builds the UTC instant corresponding to a given IST wall-clock date + HH:mm. */
function istDateTime(year: number, month: number, date: number, hhmm: string): Date {
  const parts = hhmm.split(':')
  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  if (parts.length !== 2 || Number.isNaN(hours) || Number.isNaN(minutes)) {
    throw new RangeError(`invalid HH:mm: "${hhmm}"`)
  }
  return new Date(Date.UTC(year, month, date, hours, minutes) - IST_OFFSET_MS)
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime()
}

/**
 * Computed availability: working hours minus service duration minus existing
 * live bookings. Pure — no I/O, no ambient clock. Returns candidate slot
 * start times, ascending.
 */
export function computeSlots(params: ComputeSlotsParams): readonly Date[] {
  const { workingHours, serviceDurationMinutes, busyIntervals, from, days } = params
  const stepMinutes = params.stepMinutes ?? serviceDurationMinutes
  if (serviceDurationMinutes <= 0) {
    throw new RangeError('serviceDurationMinutes must be positive')
  }
  if (stepMinutes <= 0) {
    throw new RangeError('stepMinutes must be positive')
  }
  if (days <= 0) {
    return []
  }

  const slots: Date[] = []
  const start = istParts(from)

  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    // Advance the IST calendar date by dayOffset days. Using Date.UTC with an
    // out-of-range `date` component normalises correctly (JS Date semantics),
    // so this is safe across month/year boundaries.
    const dayAnchorUtcMs = Date.UTC(start.year, start.month, start.date + dayOffset)
    const dayAnchor = new Date(dayAnchorUtcMs)
    const dayKey = DAY_KEYS[dayAnchor.getUTCDay()]!
    const windows = workingHours[dayKey] ?? []

    for (const [windowStartHHmm, windowEndHHmm] of windows) {
      const windowStart = istDateTime(start.year, start.month, start.date + dayOffset, windowStartHHmm)
      const windowEnd = istDateTime(start.year, start.month, start.date + dayOffset, windowEndHHmm)

      for (
        let candidateStart = new Date(windowStart);
        candidateStart.getTime() + serviceDurationMinutes * 60_000 <= windowEnd.getTime();
        candidateStart = new Date(candidateStart.getTime() + stepMinutes * 60_000)
      ) {
        const candidateEnd = new Date(candidateStart.getTime() + serviceDurationMinutes * 60_000)

        if (candidateStart.getTime() < from.getTime()) {
          continue // already in the past relative to the server clock
        }

        const isBusy = busyIntervals.some((busy) => overlaps(candidateStart, candidateEnd, busy.startsAt, busy.endsAt))
        if (!isBusy) {
          slots.push(candidateStart)
        }
      }
    }
  }

  return slots
}
