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

const CATEGORIES: { key: Filters['category']; label: string; dot?: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'money', label: 'Money', dot: 'var(--accent)' },
  { key: 'refused', label: 'Refused', dot: 'var(--critical)' },
  { key: 'lifecycle', label: 'Lifecycle', dot: 'var(--text-faint)' },
]

const ENFORCEMENT_LABEL: Record<BoundEnforcer, string> = {
  latch_policy: 'Latch policy',
  db_constraint: 'DB constraint',
  payment_rail: 'Payment rail',
}

const SEARCH_FIELD_LABEL: Record<SearchField, string> = {
  bookingId: 'Booking ID',
  eventId: 'Event ID',
  type: 'Type',
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}
function XIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

/** A removable summary of one narrowing currently applied. Reading the chips tells you why the count dropped. */
function ActiveChip({ label, value, onRemove }: { label: string; value: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-bg)] py-1 pl-2.5 pr-1.5 text-[length:var(--t-xs)] text-[var(--accent-text)]">
      <span className="font-medium">{label}</span>
      <span className="font-mono">{value}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        className="flex h-4 w-4 items-center justify-center rounded-full text-[var(--accent-text)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--accent)] hover:text-white"
      >
        <XIcon size={9} />
      </button>
    </span>
  )
}

export function FilterBar({
  tab,
  onTab,
  filters,
  onFilters,
  allTypes,
  totalCount,
  shownCount,
  bookingCount,
}: {
  tab: ViewTab
  onTab: (t: ViewTab) => void
  filters: Filters
  onFilters: (next: Filters) => void
  allTypes: readonly string[]
  totalCount: number
  shownCount: number
  bookingCount: number
}) {
  const hasDateRange = filters.dateFrom !== '' || filters.dateTo !== ''
  const narrowed =
    filters.category !== 'all' || filters.search.trim() !== '' || filters.enforcement !== 'all' || filters.types.size > 0 || hasDateRange

  const TABS: { key: ViewTab; label: string; count: number }[] = [
    { key: 'events', label: 'Events', count: totalCount },
    { key: 'bookings', label: 'Bookings', count: bookingCount },
  ]

  return (
    <div>
      {/* tabs + result count */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-5">
        <div role="tablist" aria-label="Table view" className="flex gap-5">
          {TABS.map((t) => {
            const active = tab === t.key
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => onTab(t.key)}
                className={`-mb-px flex items-center gap-2 border-b-2 py-3.5 text-[length:var(--t-base)] font-medium transition-colors duration-[var(--dur)] ${
                  active ? 'border-[var(--text)] text-[var(--text)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {t.label}
                <span
                  className={`rounded-full px-1.5 py-px font-mono text-[length:var(--t-2xs)] tabular-nums ${
                    active ? 'bg-[var(--text)] text-[var(--paper)]' : 'bg-[var(--paper-deep)] text-[var(--text-muted)]'
                  }`}
                >
                  {t.count}
                </span>
              </button>
            )
          })}
        </div>

        {tab === 'events' && (
          <span className="py-3.5 font-mono text-[length:var(--t-xs)] tabular-nums text-[var(--text-muted)]">
            {shownCount === totalCount ? `${totalCount} event${totalCount === 1 ? '' : 's'}` : `${shownCount} of ${totalCount} shown`}
          </span>
        )}
      </div>

      {tab === 'events' && (
        <>
          <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--line)] bg-[var(--paper-sunk)] px-5 py-3">
            {/* category — a segmented control, because the four are mutually exclusive */}
            <div className="flex rounded-lg bg-[var(--paper-deep)] p-0.5 shadow-[inset_0_0_0_1px_var(--line)]">
              {CATEGORIES.map((c) => {
                const active = filters.category === c.key
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => onFilters({ ...filters, category: c.key })}
                    aria-pressed={active}
                    className={`flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[length:var(--t-sm)] font-medium transition-colors duration-[var(--dur)] ${
                      active ? 'bg-[var(--paper)] text-[var(--text)] shadow-[0_1px_2px_oklch(0_0_0/0.08)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                    }`}
                  >
                    {c.dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.dot, opacity: active ? 1 : 0.55 }} />}
                    {c.label}
                  </button>
                )
              })}
            </div>

            {/* search — one control, field selector welded to it */}
            <div className="flex min-w-[240px] flex-1 items-center gap-2 rounded-lg border border-[var(--line-strong)] bg-[var(--paper)] pl-2.5 pr-1 transition-colors duration-[var(--dur)] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-bg)] sm:max-w-[380px]">
              <span className="text-[var(--text-faint)]">
                <SearchIcon />
              </span>
              <input
                value={filters.search}
                onChange={(e) => onFilters({ ...filters, search: e.target.value })}
                placeholder={`Search ${SEARCH_FIELD_LABEL[filters.searchField].toLowerCase()}…`}
                aria-label="Search the trail"
                className="min-w-0 flex-1 bg-transparent py-2 text-[length:var(--t-sm)] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
              />
              {filters.search && (
                <button
                  type="button"
                  onClick={() => onFilters({ ...filters, search: '' })}
                  aria-label="Clear search"
                  className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-faint)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--text)]"
                >
                  <XIcon />
                </button>
              )}
              <span className="h-4 w-px bg-[var(--line-strong)]" />
              <select
                value={filters.searchField}
                onChange={(e) => onFilters({ ...filters, searchField: e.target.value as SearchField })}
                aria-label="Search field"
                className="cursor-pointer bg-transparent py-2 pl-1 pr-1 text-[length:var(--t-sm)] font-medium text-[var(--text-muted)] outline-none"
              >
                {(Object.keys(SEARCH_FIELD_LABEL) as SearchField[]).map((f) => (
                  <option key={f} value={f}>
                    {SEARCH_FIELD_LABEL[f]}
                  </option>
                ))}
              </select>
            </div>

            <select
              value={filters.enforcement}
              onChange={(e) => onFilters({ ...filters, enforcement: e.target.value as Filters['enforcement'] })}
              aria-label="Filter by enforcement tier"
              className="control w-auto cursor-pointer py-2"
            >
              <option value="all">Any enforcement</option>
              {(Object.keys(ENFORCEMENT_LABEL) as BoundEnforcer[]).map((k) => (
                <option key={k} value={k}>
                  {ENFORCEMENT_LABEL[k]}
                </option>
              ))}
            </select>

            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return
                const next = new Set(filters.types)
                if (next.has(e.target.value)) next.delete(e.target.value)
                else next.add(e.target.value)
                onFilters({ ...filters, types: next })
              }}
              aria-label="Filter by event type"
              className="control w-auto max-w-[190px] cursor-pointer py-2"
            >
              <option value="">{filters.types.size > 0 ? `${filters.types.size} type${filters.types.size === 1 ? '' : 's'} selected` : 'Any event type'}</option>
              {allTypes.map((t) => (
                <option key={t} value={t}>
                  {filters.types.has(t) ? '✓ ' : ''}
                  {t}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] bg-[var(--paper)] px-2.5 py-1.5">
              <span className="text-[length:var(--t-xs)] font-medium text-[var(--text-muted)]">Dates</span>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => onFilters({ ...filters, dateFrom: e.target.value })}
                aria-label="From date"
                className="bg-transparent font-mono text-[length:var(--t-xs)] text-[var(--text)] outline-none [color-scheme:light]"
              />
              <span className="text-[var(--text-faint)]" aria-hidden>
                –
              </span>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => onFilters({ ...filters, dateTo: e.target.value })}
                aria-label="To date"
                className="bg-transparent font-mono text-[length:var(--t-xs)] text-[var(--text)] outline-none [color-scheme:light]"
              />
            </div>
          </div>

          {narrowed && (
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-5 py-2.5">
              <span className="text-[length:var(--t-xs)] font-medium text-[var(--text-faint)]">Narrowed by</span>
              {filters.category !== 'all' && (
                <ActiveChip label="category" value={filters.category} onRemove={() => onFilters({ ...filters, category: 'all' })} />
              )}
              {filters.search.trim() !== '' && (
                <ActiveChip label={SEARCH_FIELD_LABEL[filters.searchField]} value={filters.search.trim()} onRemove={() => onFilters({ ...filters, search: '' })} />
              )}
              {filters.enforcement !== 'all' && (
                <ActiveChip label="enforced by" value={ENFORCEMENT_LABEL[filters.enforcement]} onRemove={() => onFilters({ ...filters, enforcement: 'all' })} />
              )}
              {[...filters.types].map((t) => (
                <ActiveChip
                  key={t}
                  label="type"
                  value={t}
                  onRemove={() => {
                    const next = new Set(filters.types)
                    next.delete(t)
                    onFilters({ ...filters, types: next })
                  }}
                />
              ))}
              {hasDateRange && (
                <ActiveChip
                  label="dates"
                  value={`${filters.dateFrom || '…'} → ${filters.dateTo || '…'}`}
                  onRemove={() => onFilters({ ...filters, dateFrom: '', dateTo: '' })}
                />
              )}
              <button
                type="button"
                onClick={() => onFilters({ ...filters, category: 'all', search: '', enforcement: 'all', types: new Set(), dateFrom: '', dateTo: '' })}
                className="ml-auto text-[length:var(--t-xs)] font-medium text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text)] hover:underline"
              >
                Clear all
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
