import { useMemo, useState } from 'react'
import { BookingsTable } from './BookingsTable'
import { EnforcementBreakdown } from './EnforcementBreakdown'
import { EventsTable } from './EventsTable'
import type { Filters, ViewTab } from './FilterBar'
import { FilterBar } from './FilterBar'
import { MoneyFlowChart } from './MoneyFlowChart'
import { PolicyEditor } from './PolicyEditor'
import { StatCards } from './StatCards'
import { computeRunningSeries, computeTotals, countByEnforcement, countRefusals } from './totals'
import type { Section } from './TopNav'
import { TopNav } from './TopNav'
import type { BookingEvent } from './types'
import { eventCategory } from './types'
import { useEventStream } from './useEventStream'

const token = import.meta.env['VITE_AUDIT_TRAIL_TOKEN'] as string | undefined
const streamUrl = `/events${token ? `?token=${encodeURIComponent(token)}` : ''}`

const CONNECTION_LABEL: Record<string, { text: string; dot: string }> = {
  connecting: { text: 'CONNECTING', dot: 'bg-[var(--text-faint)]' },
  open: { text: 'LIVE', dot: 'bg-[var(--good)]' },
  reconnecting: { text: 'RECONNECTING', dot: 'bg-[var(--warning)]' },
}

function inDateRange(event: BookingEvent, from: string, to: string): boolean {
  if (!from && !to) return true
  const d = event.occurredAt.slice(0, 10)
  if (from && d < from) return false
  if (to && d > to) return false
  return true
}

function matchesSearch(event: BookingEvent, filters: Filters): boolean {
  if (!filters.search.trim()) return true
  const needle = filters.search.trim().toLowerCase()
  const haystack = filters.searchField === 'bookingId' ? event.bookingId : filters.searchField === 'eventId' ? event.eventId : event.type
  return haystack.toLowerCase().includes(needle)
}

export default function App() {
  const { events, connection } = useEventStream(streamUrl)
  const [section, setSection] = useState<Section>('audits')
  const [tab, setTab] = useState<ViewTab>('events')
  const [filters, setFilters] = useState<Filters>({
    category: 'all',
    search: '',
    searchField: 'bookingId',
    dateFrom: '',
    dateTo: '',
    enforcement: 'all',
    types: new Set(),
  })

  const dateScoped = useMemo(() => events.filter((e) => inDateRange(e, filters.dateFrom, filters.dateTo)), [events, filters.dateFrom, filters.dateTo])

  const totals = useMemo(() => computeTotals(dateScoped), [dateScoped])
  const series = useMemo(() => computeRunningSeries(dateScoped), [dateScoped])
  const enforcementCounts = useMemo(() => countByEnforcement(dateScoped), [dateScoped])
  const refusalCount = useMemo(() => countRefusals(dateScoped), [dateScoped])
  const bookingCount = useMemo(() => new Set(dateScoped.map((e) => e.bookingId)).size, [dateScoped])
  const allTypes = useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events])

  const tableFiltered = useMemo(() => {
    return dateScoped.filter((e) => {
      if (filters.category !== 'all' && eventCategory(e) !== filters.category) return false
      if (!matchesSearch(e, filters)) return false
      if (filters.enforcement !== 'all') {
        const enforcedBy = e.bound?.enforcedBy ?? (e.type === 'AUTHORIZATION_HELD' ? 'payment_rail' : undefined)
        if (enforcedBy !== filters.enforcement) return false
      }
      if (filters.types.size > 0 && !filters.types.has(e.type)) return false
      return true
    })
  }, [dateScoped, filters])

  const newestFirst = useMemo(() => [...tableFiltered].reverse(), [tableFiltered])
  const connLabel = CONNECTION_LABEL[connection] ?? CONNECTION_LABEL['connecting']!

  return (
    <div className="min-h-screen bg-[var(--bg)] pb-24">
      <TopNav
        section={section}
        onSection={setSection}
        liveCount={events.length}
        refusalCount={refusalCount}
        onSearch={(query) => {
          setSection('audits')
          setTab('events')
          // Global search has no field dropdown of its own — guess it from
          // the query's shape: SCREAMING_SNAKE_CASE reads as an event type,
          // "bkg_"/"evt_" prefixes as their respective ids, anything else
          // falls back to booking id (the common case).
          const looksLikeType = /^[A-Z][A-Z0-9_]*$/.test(query.trim())
          const searchField = looksLikeType ? 'type' : query.startsWith('evt_') ? 'eventId' : 'bookingId'
          setFilters((f) => ({ ...f, search: query, searchField }))
        }}
      />

      {/* secondary bar */}
      <header className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-6 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="text-[15px] font-semibold text-[var(--text)]">Overview</span>
          <span className="text-[15px] text-[var(--text-muted)]">{section === 'policy' ? 'Policy' : 'Audit Trail'}</span>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-white px-3 py-1.5">
          <span className={`h-2 w-2 rounded-full ${connLabel.dot} ${connection === 'open' ? 'animate-pulse' : ''}`} />
          <span className="font-mono text-[11px] font-semibold tracking-wider text-[var(--text-muted)]">{connLabel.text}</span>
        </div>
        <div className="font-mono text-[13px] text-[var(--blue-text)]">docs/03-domain-model.md ↗</div>
      </header>

      <main className="mx-auto max-w-[1200px] px-6 py-6">
        {section === 'policy' ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            <PolicyEditor />
          </div>
        ) : (
          <>
            <StatCards totals={totals} refusalCount={refusalCount} bookingCount={bookingCount} onFilterRefusals={() => setFilters((f) => ({ ...f, category: 'refused' }))} />

            {/* charts */}
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 lg:col-span-2">
                <div className="mb-3 text-[14px] font-semibold text-[var(--text)]">Cumulative money flow</div>
                <MoneyFlowChart series={series} />
              </div>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
                <div className="mb-4 text-[14px] font-semibold text-[var(--text)]">Events by enforcement tier</div>
                <EnforcementBreakdown counts={enforcementCounts} />
              </div>
            </div>

            {/* table */}
            <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <FilterBar
                tab={tab}
                onTab={setTab}
                filters={filters}
                onFilters={setFilters}
                allTypes={allTypes}
                totalCount={dateScoped.length}
                shownCount={tableFiltered.length}
              />

              {!token && (
                <div className="mx-6 mt-4 rounded-lg border border-[var(--warning)] bg-[var(--warning-bg)] px-3 py-2 font-mono text-xs text-[var(--warning-text)]">
                  VITE_AUDIT_TRAIL_TOKEN is not set in web/.env — the SSE connection will be refused (401).
                </div>
              )}

              {tab === 'events' ? (
                newestFirst.length === 0 ? (
                  <div className="px-6 py-16 text-center font-mono text-sm text-[var(--text-faint)]">
                    {events.length === 0 ? 'waiting for events — drive an agent through the MCP tools to see the trail populate live' : 'no events match these filters'}
                  </div>
                ) : (
                  <div className="mt-2">
                    <EventsTable events={newestFirst} />
                  </div>
                )
              ) : (
                <BookingsTable events={dateScoped} />
              )}
            </div>
          </>
        )}
      </main>

      {/* floating live indicator */}
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        className="fixed bottom-6 right-6 flex items-center gap-2 rounded-full bg-[var(--text)] px-4 py-3 text-white shadow-lg transition hover:shadow-xl"
      >
        <span className={`h-2 w-2 rounded-full ${connLabel.dot} ${connection === 'open' ? 'animate-pulse' : ''}`} />
        <span className="text-[13px] font-medium">
          {connLabel.text} · {events.length} events
        </span>
      </button>
    </div>
  )
}
