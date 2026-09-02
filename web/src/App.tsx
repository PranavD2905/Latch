import { useEffect, useMemo, useState } from 'react'
import { BookingsTable, useBookingRows } from './BookingsTable'
import { EnforcementBreakdown } from './EnforcementBreakdown'
import { EventsTable } from './EventsTable'
import type { Filters } from './FilterBar'
import { FilterBar } from './FilterBar'
import { LatchMark } from './LatchMark'
import { MoneyFlowChart } from './MoneyFlowChart'
import { Pagination } from './Pagination'
import { PolicyEditor } from './PolicyEditor'
import { SummaryCards } from './SummaryCards'
import type { View } from './Sidebar'
import { CompactNav, Sidebar } from './Sidebar'
import type { Section } from './TopBar'
import { TopBar } from './TopBar'
import { AlertIcon, ChevronDown, ExternalIcon, LedgerIcon } from './icons'
import { computeRunningSeries, computeTotals, countByEnforcement, countRefusals } from './totals'
import type { BookingEvent } from './types'
import { eventCategory } from './types'
import { useArrivals } from './useArrivals'
import { useEventStream } from './useEventStream'

const token = import.meta.env['VITE_AUDIT_TRAIL_TOKEN'] as string | undefined
const streamUrl = `/events${token ? `?token=${encodeURIComponent(token)}` : ''}`
const REPO_URL = 'https://github.com/PranavD2905/Latch'

const SCOPES = [
  { key: 'all', label: 'All time', days: 0 },
  { key: '1', label: 'Today', days: 1 },
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
] as const
type ScopeKey = (typeof SCOPES)[number]['key']

function daysAgoISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - (days - 1))
  return d.toISOString().slice(0, 10)
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
  const arrivals = useArrivals(events)
  const [view, setView] = useState<View>('events')
  const [scope, setScope] = useState<ScopeKey>('all')
  const [filters, setFilters] = useState<Filters>({
    category: 'all',
    search: '',
    searchField: 'bookingId',
    dateFrom: '',
    dateTo: '',
    enforcement: 'all',
    types: new Set(),
  })
  const [eventsPage, setEventsPage] = useState({ page: 1, pageSize: 25 })
  const [bookingsPage, setBookingsPage] = useState({ page: 1, pageSize: 25 })

  const section: Section = view === 'policy' ? 'policy' : 'audits'

  // A filter change can shrink the result set out from under whatever page the
  // user was on — reset to page 1 rather than leave them staring at an empty table.
  useEffect(() => {
    setEventsPage((p) => ({ ...p, page: 1 }))
    setBookingsPage((p) => ({ ...p, page: 1 }))
  }, [filters])

  function handleView(next: View) {
    setView(next)
  }

  function handleScope(next: ScopeKey) {
    setScope(next)
    setFilters((f) => ({ ...f, dateFrom: next === 'all' ? '' : daysAgoISO(Number(next)), dateTo: '' }))
  }

  const dateScoped = useMemo(() => events.filter((e) => inDateRange(e, filters.dateFrom, filters.dateTo)), [events, filters.dateFrom, filters.dateTo])

  const totals = useMemo(() => computeTotals(dateScoped), [dateScoped])
  const series = useMemo(() => computeRunningSeries(dateScoped), [dateScoped])
  const enforcementCounts = useMemo(() => countByEnforcement(dateScoped), [dateScoped])
  const refusalCount = useMemo(() => countRefusals(dateScoped), [dateScoped])
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
  const bookingRows = useBookingRows(dateScoped)
  const bookingCount = bookingRows.length

  const trailWindow =
    dateScoped.length === 0
      ? 'No events in this window'
      : `${new Date(dateScoped[0]!.occurredAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} – ${new Date(
          dateScoped[dateScoped.length - 1]!.occurredAt,
        ).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} · append-only`

  const showingEvents = view !== 'bookings'
  const activePage = showingEvents ? eventsPage : bookingsPage
  const rowTotal = showingEvents ? newestFirst.length : bookingCount
  const rangeFrom = rowTotal === 0 ? 0 : (Math.min(activePage.page, Math.max(1, Math.ceil(rowTotal / activePage.pageSize))) - 1) * activePage.pageSize + 1
  const rangeTo = Math.min(rangeFrom + activePage.pageSize - 1, rowTotal)

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <TopBar connection={connection} eventCount={events.length} />

      <div className="flex">
        <Sidebar view={view} onView={handleView} refusalCount={refusalCount} trailWindow={trailWindow} />

        <main className="flex min-h-[calc(100vh-var(--topbar-h))] min-w-0 flex-1 flex-col">
          <CompactNav view={view} onView={handleView} refusalCount={refusalCount} />

          <div className="flex-1 px-4 py-5 sm:px-6">
            {/* page header */}
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h1 className="text-[length:var(--t-lg)] font-semibold tracking-[-0.01em] text-[var(--text)]">
                  {section === 'policy' ? 'Policy' : view === 'bookings' ? 'Bookings' : 'Overview'}
                </h1>
                {section === 'audits' && (
                  <label className="flex cursor-pointer items-center gap-0.5 text-[var(--blue)]">
                    <select
                      value={scope}
                      onChange={(e) => handleScope(e.target.value as ScopeKey)}
                      aria-label="Time window"
                      className="cursor-pointer appearance-none bg-transparent text-[length:var(--t-lg)] font-semibold tracking-[-0.01em] outline-none"
                    >
                      {SCOPES.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={15} />
                  </label>
                )}
              </div>
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="link flex items-center gap-1.5 text-[length:var(--t-sm)]">
                Documentation
                <ExternalIcon size={13} />
              </a>
            </div>

            {!token && section === 'audits' && (
              <div
                className="mb-4 flex items-start gap-2.5 rounded-[var(--r-card)] border border-[var(--warning)] bg-[var(--warning-bg)] px-4 py-3 text-[length:var(--t-sm)] leading-relaxed text-[var(--warning-text)]"
                role="status"
              >
                <span className="mt-px shrink-0">
                  <AlertIcon size={14} />
                </span>
                <span>VITE_AUDIT_TRAIL_TOKEN is not set in web/.env — the SSE connection will be refused (401).</span>
              </div>
            )}

            {section === 'policy' ? (
              <PolicyEditor />
            ) : (
              <>
                <SummaryCards
                  totals={totals}
                  refusalCount={refusalCount}
                  bookingCount={bookingCount}
                  eventCount={dateScoped.length}
                  onFilterRefusals={() => {
                    setView('events')
                    setFilters((f) => ({ ...f, category: 'refused' }))
                  }}
                />

                <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
                  <div className="card xl:col-span-2">
                    <div className="card-head">
                      <h2 className="text-[length:var(--t-base)] font-semibold text-[var(--text)]">Cumulative money flow</h2>
                      <span className="text-[length:var(--t-sm)] text-[var(--text-muted)]">one point per event, shared ₹ axis</span>
                    </div>
                    <div className="border-t border-[var(--border)] px-5 py-4">
                      <MoneyFlowChart series={series} />
                    </div>
                  </div>
                  <div className="card">
                    <div className="card-head">
                      <h2 className="text-[length:var(--t-base)] font-semibold text-[var(--text)]">Enforcement tiers</h2>
                      <span className="text-[length:var(--t-sm)] text-[var(--text-muted)]">what held the line</span>
                    </div>
                    <div className="border-t border-[var(--border)] px-5 py-4">
                      <EnforcementBreakdown counts={enforcementCounts} />
                    </div>
                  </div>
                </div>

                <div className="card mt-4 overflow-hidden">
                  {showingEvents ? (
                    <FilterBar
                      filters={filters}
                      onFilters={setFilters}
                      allTypes={allTypes}
                      totalCount={dateScoped.length}
                      shownCount={newestFirst.length}
                      rangeFrom={rangeFrom}
                      rangeTo={rangeTo}
                      unit="events"
                    />
                  ) : (
                    <div className="px-4 pb-3 pt-4 text-[length:var(--t-sm)] text-[var(--text-secondary)]">
                      {bookingCount === 0
                        ? 'No bookings'
                        : `Showing ${rangeFrom.toLocaleString('en-IN')}–${rangeTo.toLocaleString('en-IN')} of ${bookingCount.toLocaleString('en-IN')} bookings`}
                    </div>
                  )}

                  {showingEvents ? (
                    newestFirst.length === 0 ? (
                      <EmptyTrail
                        hasEvents={events.length > 0}
                        onClear={() => setFilters({ ...filters, category: 'all', search: '', enforcement: 'all', types: new Set() })}
                      />
                    ) : (
                      <EventsTable events={newestFirst} arrivals={arrivals} page={eventsPage.page} pageSize={eventsPage.pageSize} />
                    )
                  ) : bookingCount === 0 ? (
                    <EmptyTrail hasEvents={events.length > 0} onClear={() => handleView('events')} />
                  ) : (
                    <BookingsTable rows={bookingRows} page={bookingsPage.page} pageSize={bookingsPage.pageSize} />
                  )}

                  {showingEvents ? (
                    <Pagination
                      page={eventsPage.page}
                      pageSize={eventsPage.pageSize}
                      totalCount={newestFirst.length}
                      onPageChange={(page) => setEventsPage((p) => ({ ...p, page }))}
                      onPageSizeChange={(pageSize) => setEventsPage({ page: 1, pageSize })}
                      label="events"
                    />
                  ) : (
                    <Pagination
                      page={bookingsPage.page}
                      pageSize={bookingsPage.pageSize}
                      totalCount={bookingCount}
                      onPageChange={(page) => setBookingsPage((p) => ({ ...p, page }))}
                      onPageSizeChange={(pageSize) => setBookingsPage({ page: 1, pageSize })}
                      label="bookings"
                    />
                  )}
                </div>

                <p className="mt-4 max-w-[74ch] text-[length:var(--t-sm)] leading-relaxed text-[var(--text-muted)]">
                  Every row above is an immutable, append-only fact recorded at the moment the action was attempted — including the ones that were refused.
                  Nothing here is reconstructed after the fact.
                </p>
              </>
            )}
          </div>

          <footer className="border-t border-[var(--border)] px-4 py-4 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[length:var(--t-sm)] text-[var(--text-muted)]">
              <span className="flex items-center gap-2">
                <LatchMark size={14} />
                Latch — bounded payments for agentic bookings
              </span>
              <span title="Deposits, refunds and authorisations are executed and enforced by Razorpay — the payment_rail tier in this trail.">
                Payments by <span className="font-medium text-[var(--text-secondary)]">Razorpay</span>
              </span>
            </div>
          </footer>
        </main>
      </div>
    </div>
  )
}

/**
 * Two genuinely different empty states: nothing has streamed yet (teach what
 * makes the trail fill), versus filters that exclude everything (offer the
 * way out). "No data" for both would be the lazy answer.
 */
function EmptyTrail({ hasEvents, onClear }: { hasEvents: boolean; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 border-t border-[var(--border)] px-6 py-20 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--neutral-bg)] text-[var(--text-muted)]" aria-hidden>
        <LedgerIcon size={20} />
      </div>
      {hasEvents ? (
        <>
          <div className="text-[length:var(--t-md)] font-semibold text-[var(--text)]">No events match these filters</div>
          <div className="max-w-[46ch] text-[length:var(--t-sm)] text-[var(--text-muted)]">The trail still holds every event — this view is just narrowed.</div>
          <button type="button" onClick={onClear} className="btn btn-secondary mt-1">
            Clear filters
          </button>
        </>
      ) : (
        <>
          <div className="text-[length:var(--t-md)] font-semibold text-[var(--text)]">Waiting for the first event</div>
          <div className="max-w-[54ch] text-[length:var(--t-sm)] leading-relaxed text-[var(--text-muted)]">
            Drive an agent through the MCP tools — <span className="font-medium text-[var(--text)]">hold_slot</span>,{' '}
            <span className="font-medium text-[var(--text)]">confirm_with_deposit</span>, <span className="font-medium text-[var(--text)]">cancel</span> — and
            each attempt lands here as it happens, refusals included.
          </div>
        </>
      )}
    </div>
  )
}
