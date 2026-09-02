import { useEffect, useRef, useState } from 'react'
import type { BookingEvent } from './types'

const ARRIVAL_MS = 1200

/**
 * Which events turned up on the live feed *since this tab has been watching*
 * — used to wash a row in as it lands. The first batch (the SSE replay of
 * history on connect) is deliberately excluded: replayed history isn't news,
 * and animating forty rows at once on load would be exactly the orchestrated
 * page-load sequence a product surface shouldn't have.
 */
export function useArrivals(events: readonly BookingEvent[]): ReadonlySet<string> {
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(new Set())
  const known = useRef<Set<string> | null>(null)

  useEffect(() => {
    if (known.current === null) {
      known.current = new Set(events.map((e) => e.eventId))
      return
    }
    const fresh = events.filter((e) => !known.current!.has(e.eventId)).map((e) => e.eventId)
    if (fresh.length === 0) return
    for (const id of fresh) known.current.add(id)
    setArrivals((prev) => new Set([...prev, ...fresh]))
    const timer = setTimeout(() => {
      setArrivals((prev) => {
        const next = new Set(prev)
        for (const id of fresh) next.delete(id)
        return next
      })
    }, ARRIVAL_MS)
    return () => clearTimeout(timer)
  }, [events])

  return arrivals
}
