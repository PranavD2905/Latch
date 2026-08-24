import { useEffect, useRef, useState } from 'react'
import type { BookingEvent } from './types'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting'

export interface EventStream {
  events: readonly BookingEvent[]
  connection: ConnectionState
}

/**
 * Owns the `EventSource` against the Slice 6 SSE feed
 * (`src/adapters/audit-trail/server.ts`). `EventSource` replays history and
 * resumes correctly on its own on reconnect (native `Last-Event-ID`
 * handling) — this hook's job is just to accumulate what arrives, deduped by
 * `eventId` in case a reconnect's window overlaps what's already held, and
 * surface a connection indicator for the "reconnecting after a dropped
 * connection replays correctly" acceptance criterion to be visibly true on
 * screen, not just true in the network tab.
 */
export function useEventStream(url: string): EventStream {
  const [events, setEvents] = useState<readonly BookingEvent[]>([])
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const seenIds = useRef<Set<string>>(new Set())
  const hasOpenedOnce = useRef(false)

  useEffect(() => {
    const source = new EventSource(url)

    source.onopen = () => {
      setConnection('open')
    }

    source.onerror = () => {
      // The browser's EventSource retries on its own; if it had ever opened
      // before, a subsequent error means it's mid-reconnect, not dead.
      setConnection(hasOpenedOnce.current ? 'reconnecting' : 'connecting')
    }

    source.onmessage = (message) => {
      hasOpenedOnce.current = true
      const parsed = JSON.parse(message.data) as BookingEvent
      if (seenIds.current.has(parsed.eventId)) return
      seenIds.current.add(parsed.eventId)
      setEvents((prev) => [...prev, parsed])
    }

    return () => source.close()
  }, [url])

  return { events, connection }
}
