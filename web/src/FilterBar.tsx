import type { BoundEnforcer, EventCategory } from './types'

export type SearchField = 'bookingId' | 'eventId' | 'type'
export type ViewTab = 'events' | 'bookings'

export interface Filters {
  category: EventCategory | 'all'
  search: string
  searchField: SearchField
  dateFrom: string
  dateTo: string
  enforcement: BoundEnforcer | 'all'
  types: ReadonlySet<string>
}

const CATEGORY_PILLS: { key: Filters['category']; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'money', label: 'Money' },
  { key: 'refused', label: 'Refused' },
  { key: 'lifecycle', label: 'Lifecycle' },
]

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}
function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
function ChevronDown() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

const PILL = 'flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-white px-3.5 py-2.5 text-[14px] text-[var(--text)]'

export function FilterBar({
  tab,
  onTab,
  filters,
  onFilters,
  allTypes,
  totalCount,
  shownCount,
}: {
  tab: ViewTab
  onTab: (t: ViewTab) => void
  filters: Filters
  onFilters: (next: Filters) => void
  allTypes: readonly string[]
  totalCount: number
  shownCount: number
}) {
  const hasDateRange = filters.dateFrom !== '' || filters.dateTo !== ''

  return (
    <div>
      {/* tabs */}
      <div className="flex gap-6 border-b border-[var(--border)] px-6">
        {(['events', 'bookings'] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTab(t)}
            className={`-mb-px border-b-2 py-3 text-[15px] font-medium capitalize transition ${
              tab === t ? 'border-[var(--text)] text-[var(--text)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'events' && (
        <>
          {/* category pills + search */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-4">
            <div className="flex items-center gap-7">
              {CATEGORY_PILLS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => onFilters({ ...filters, category: p.key })}
                  className={`text-[15px] transition ${
                    filters.category === p.key ? 'font-semibold text-[var(--text)]' : 'font-medium text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2.5 rounded-lg bg-[var(--slate-bg)] pl-3.5 pr-3">
              <SearchIcon />
              <input
                value={filters.search}
                onChange={(e) => onFilters({ ...filters, search: e.target.value })}
                placeholder="Search"
                className="w-40 bg-transparent py-2.5 text-[14px] outline-none placeholder:text-[var(--text-faint)]"
              />
              <div className="h-5 w-px bg-[var(--border-strong)]" />
              <select
                value={filters.searchField}
                onChange={(e) => onFilters({ ...filters, searchField: e.target.value as SearchField })}
                className="appearance-none bg-transparent py-2.5 pl-1.5 pr-1 text-[14px] font-medium text-[var(--text-muted)] outline-none"
              >
                <option value="bookingId">in Booking ID</option>
                <option value="eventId">in Event ID</option>
                <option value="type">in Type</option>
              </select>
            </div>
          </div>

          {/* filter chips */}
          <div className="flex flex-wrap items-center gap-2 px-6 pt-3">
            <div className={PILL}>
              <span className="text-[var(--text-muted)]">Date Range:</span>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => onFilters({ ...filters, dateFrom: e.target.value })}
                className="bg-transparent outline-none [color-scheme:light]"
              />
              <span className="text-[var(--text-faint)]">–</span>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => onFilters({ ...filters, dateTo: e.target.value })}
                className="bg-transparent outline-none [color-scheme:light]"
              />
              {hasDateRange && (
                <button onClick={() => onFilters({ ...filters, dateFrom: '', dateTo: '' })} className="ml-1 text-[var(--text-faint)] hover:text-[var(--text)]">
                  <XIcon />
                </button>
              )}
            </div>

            <label className={PILL}>
              <span className="text-[var(--text-muted)]">Enforcement</span>
              <select
                value={filters.enforcement}
                onChange={(e) => onFilters({ ...filters, enforcement: e.target.value as Filters['enforcement'] })}
                className="appearance-none bg-transparent outline-none"
              >
                <option value="all">All</option>
                <option value="latch_policy">Latch policy</option>
                <option value="db_constraint">DB constraint</option>
                <option value="payment_rail">Payment rail</option>
              </select>
              <ChevronDown />
            </label>

            <label className={PILL}>
              <span className="text-[var(--text-muted)]">Event Type</span>
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return
                  const next = new Set(filters.types)
                  if (next.has(e.target.value)) next.delete(e.target.value)
                  else next.add(e.target.value)
                  onFilters({ ...filters, types: next })
                }}
                className="appearance-none bg-transparent outline-none"
              >
                <option value="">{filters.types.size > 0 ? `${filters.types.size} selected` : 'Any'}</option>
                {allTypes.map((t) => (
                  <option key={t} value={t}>
                    {filters.types.has(t) ? '✓ ' : ''}
                    {t}
                  </option>
                ))}
              </select>
              <ChevronDown />
            </label>
            {filters.types.size > 0 && (
              <button
                onClick={() => onFilters({ ...filters, types: new Set() })}
                className="text-[13px] text-[var(--blue-text)] hover:underline"
              >
                clear types
              </button>
            )}
          </div>

          <div className="px-6 pt-3 text-[13px] text-[var(--text-muted)]">
            Showing {shownCount} of {totalCount} event{totalCount === 1 ? '' : 's'}
          </div>
        </>
      )}
    </div>
  )
}
