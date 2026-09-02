import { useEffect, useMemo, useState } from 'react'
import { BookingsTable } from './BookingsTable'
import { EnforcementBreakdown } from './EnforcementBreakdown'
import { EventsTable } from './EventsTable'
import type { Filters, ViewTab } from './FilterBar'
import { FilterBar } from './FilterBar'
import { LatchMark } from './LatchMark'
import { LedgerSummary } from './LedgerSummary'
import { MoneyFlowChart } from './MoneyFlowChart'
import { PolicyEditor } from './PolicyEditor'
import { computeRunningSeries, computeTotals, countByEnforcement, countRefusals } from './totals'
import type { Section } from './TopNav'
import { TopNav } from './TopNav'
import type { BookingEvent } from './types'
import { eventCategory } from './types'
import { useArrivals } from './useArrivals'
import { useEventStream } from './useEventStream'

const token = import.meta.env['VITE_AUDIT_TRAIL_TOKEN'] as string | undefined
const streamUrl = `/events${token ? `?token=${encodeURIComponent(token)}` : ''}`

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

/**
 * Shell footer. The Razorpay line is an attribution, not a co-brand: the
 * strongest tier in this trail is `payment_rail`, and the badge on those rows
 * already says "enforced by Razorpay — outside our trust boundary". Naming
 * the rail here closes that loop for someone reading the dashboard cold.
 */
function ShellFooter() {
  return (
    <footer className="on-ink border-t border-[var(--ink-line-soft)] px-5 py-5 sm:px-7">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <span className="flex items-center gap-2 text-[length:var(--t-xs)] text-[var(--on-ink-faint)]">
          <LatchMark size={14} />
          Latch — bounded payments for agentic bookings
        </span>
        <span
          className="text-[length:var(--t-xs)] text-[var(--on-ink-faint)]"
          title="Deposits, refunds and authorisations are executed and enforced by Razorpay — the payment_rail tier in this trail."
        >
          Payments by <span className="font-medium text-[var(--on-ink-muted)]">Razorpay</span>
        </span>
      </div>
    </footer>
  )
}

/** Panel heading — one shape for every paper panel in the app. */
function PanelHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pb-4 pt-5">
      <h2 className="text-[length:var(--t-base)] font-semibold tracking-[-0.005em] text-[var(--text)]">{title}</h2>
      {note && <span className="text-[length:var(--t-xs)] text-[var(--text-muted)]">{note}</span>}
    </div>
  )
}

export default function App() {
  const { events, connection } = useEventStream(streamUrl)
  const arrivals = useArrivals(events)
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
  const [eventsPagination, setEventsPagination] = useState({ page: 1, pageSize: 10 })
  const [bookingsPagination, setBookingsPagination] = useState({ page: 1, pageSize: 10 })

  // A filter change can shrink the result set out from under whatever page the
  // user was on — reset to page 1 rather than leave them staring at an empty table.
  useEffect(() => {
    setEventsPagination((p) => ({ ...p, page: 1 }))
    setBookingsPagination((p) => ({ ...p, page: 1 }))
  }, [filters])

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

  return (
    <div className="min-h-screen bg-[var(--ink)]">
      <TopNav section={section} onSection={setSection} refusalCount={refusalCount} connection={connection} eventCount={events.length} />

      {section === 'policy' ? (
        <>
          <section className="on-ink px-5 pb-7 pt-6 sm:px-7">
            <div className="mx-auto max-w-[1240px]">
              <div className="font-mono text-[length:var(--t-xs)] text-[var(--on-ink-faint)]">Dr. Rao&apos;s Clinic · merchant API</div>
              <h1 className="mt-2 text-[length:var(--t-2xl)] font-semibold tracking-[-0.02em] text-[var(--on-ink)]">Policy</h1>
              <p className="mt-2 max-w-[68ch] text-[length:var(--t-sm)] leading-relaxed text-[var(--on-ink-muted)]">
                What an agent is allowed to do on this merchant&apos;s behalf, and what a cancellation costs. Publishing appends a new version — it never edits
                the one bookings are already citing.
              </p>
            </div>
          </section>
          <main className="mx-auto max-w-[1240px] px-5 pb-14 sm:px-7">
            <PolicyEditor />
          </main>
          <ShellFooter />
        </>
      ) : (
        <>
          <LedgerSummary
            totals={totals}
            refusalCount={refusalCount}
            bookingCount={bookingCount}
            eventCount={dateScoped.length}
            firstAt={dateScoped[0]?.occurredAt}
            lastAt={dateScoped[dateScoped.length - 1]?.occurredAt}
            onFilterRefusals={() => setFilters((f) => ({ ...f, category: 'refused' }))}
          />

          <main className="mx-auto max-w-[1240px] px-5 pb-14 sm:px-7">
            {!token && (
              <div
                className="mb-4 flex items-start gap-2.5 rounded-xl px-4 py-3 font-mono text-[length:var(--t-xs)] leading-relaxed"
                style={{ background: 'oklch(0.775 0.145 78 / 0.13)', color: 'var(--warning-on-ink)', boxShadow: 'inset 0 0 0 1px oklch(0.775 0.145 78 / 0.3)' }}
                role="status"
              >
                <span aria-hidden>⚠</span>
                <span>VITE_AUDIT_TRAIL_TOKEN is not set in web/.env — the SSE connection will be refused (401).</span>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="panel lg:col-span-2">
                <PanelHead title="Cumulative money flow" note="one point per event, shared ₹ axis" />
                <div className="px-5 pb-5">
                  <MoneyFlowChart series={series} />
                </div>
              </div>
              <div className="panel">
                <PanelHead title="Enforcement tiers" note="what actually held the line" />
                <div className="px-5 pb-5">
                  <EnforcementBreakdown counts={enforcementCounts} />
                </div>
              </div>
            </div>

            <div className="panel mt-4">
              <FilterBar
                tab={tab}
                onTab={setTab}
                filters={filters}
                onFilters={setFilters}
                allTypes={allTypes}
                totalCount={dateScoped.length}
                shownCount={tableFiltered.length}
                bookingCount={bookingCount}
              />

              {tab === 'events' ? (
                newestFirst.length === 0 ? (
                  <EmptyTrail hasEvents={events.length > 0} onClear={() => setFilters((f) => ({ ...f, category: 'all', search: '', enforcement: 'all', types: new Set() }))} />
                ) : (
                  <EventsTable
                    events={newestFirst}
                    arrivals={arrivals}
                    page={eventsPagination.page}
                    pageSize={eventsPagination.pageSize}
                    onPageChange={(page) => setEventsPagination((p) => ({ ...p, page }))}
                    onPageSizeChange={(pageSize) => setEventsPagination({ page: 1, pageSize })}
                  />
                )
              ) : (
                <BookingsTable
                  events={dateScoped}
                  page={bookingsPagination.page}
                  pageSize={bookingsPagination.pageSize}
                  onPageChange={(page) => setBookingsPagination((p) => ({ ...p, page }))}
                  onPageSizeChange={(pageSize) => setBookingsPagination({ page: 1, pageSize })}
                />
              )}
            </div>

            <p className="mt-5 max-w-[70ch] text-[length:var(--t-xs)] leading-relaxed text-[var(--on-ink-faint)]">
              Every row above is an immutable, append-only fact recorded at the moment the action was attempted — including the ones that were refused. Nothing
              here is reconstructed after the fact.
            </p>
          </main>
          <ShellFooter />
        </>
      )}
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
    <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--paper-deep)] text-[var(--text-faint)]" aria-hidden>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 9h8M8 13h8M8 17h4" />
        </svg>
      </div>
      {hasEvents ? (
        <>
          <div className="text-[length:var(--t-base)] font-medium text-[var(--text)]">No events match these filters</div>
          <div className="max-w-[46ch] text-[length:var(--t-sm)] text-[var(--text-muted)]">The trail still holds every event — this view is just narrowed.</div>
          <button type="button" onClick={onClear} className="btn btn-secondary mt-1">
            Clear filters
          </button>
        </>
      ) : (
        <>
          <div className="text-[length:var(--t-base)] font-medium text-[var(--text)]">Waiting for the first event</div>
          <div className="max-w-[52ch] text-[length:var(--t-sm)] leading-relaxed text-[var(--text-muted)]">
            Drive an agent through the MCP tools — <span className="font-mono text-[var(--text)]">hold_slot</span>,{' '}
            <span className="font-mono text-[var(--text)]">confirm_with_deposit</span>, <span className="font-mono text-[var(--text)]">cancel</span> — and each
            attempt lands here as it happens, refusals included.
          </div>
        </>
      )}
    </div>
  )
}
