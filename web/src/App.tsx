import { useMemo } from 'react'
import { EventCard } from './EventCard'
import { computeTotals } from './totals'
import { TotalsBar } from './TotalsBar'
import { useEventStream } from './useEventStream'

const token = import.meta.env['VITE_AUDIT_TRAIL_TOKEN'] as string | undefined
const streamUrl = `/events${token ? `?token=${encodeURIComponent(token)}` : ''}`

export default function App() {
  const { events, connection } = useEventStream(streamUrl)
  const totals = useMemo(() => computeTotals(events), [events])

  // Newest first — slice-6.md item 2: "the trail as a live list, newest
  // activity visible without scrolling."
  const newestFirst = useMemo(() => [...events].reverse(), [events])

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-slate-100">
      <header className="border-b border-slate-800 px-5 py-4">
        <h1 className="font-mono text-lg font-bold tracking-tight">Latch — live audit trail</h1>
        <p className="mt-0.5 font-mono text-xs text-slate-500">
          every event, in order — rupee-traceable, gate-checked, bound to a named enforcer
        </p>
      </header>

      <TotalsBar totals={totals} connection={connection} />

      <main className="mx-auto flex max-w-4xl flex-col gap-2 px-5 py-5">
        {!token && (
          <div className="rounded-lg border border-amber-600 bg-amber-950/40 px-3 py-2 font-mono text-xs text-amber-300">
            VITE_AUDIT_TRAIL_TOKEN is not set in web/.env — the SSE connection will be refused (401).
          </div>
        )}
        {newestFirst.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-700 px-4 py-8 text-center font-mono text-sm text-slate-500">
            waiting for events — drive an agent through the MCP tools to see the trail populate live
          </div>
        ) : (
          newestFirst.map((event) => <EventCard key={event.eventId} event={event} />)
        )}
      </main>
    </div>
  )
}
