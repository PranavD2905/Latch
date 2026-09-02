import { ChevronDown, SearchIcon, XIcon } from './icons'
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

const CATEGORIES: { key: Filters['category']; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'money', label: 'Money' },
  { key: 'refused', label: 'Refused' },
  { key: 'lifecycle', label: 'Lifecycle' },
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

/** A bordered dropdown that shows its current value in the label, the way the dashboard's filter row does. */
function SelectChip({
  label,
  value,
  active,
  children,
  onChange,
  width,
}: {
  label: string
  value: string
  active: boolean
  children: React.ReactNode
  onChange: (v: string) => void
  width?: string
}) {
  return (
    <label className={`chip cursor-pointer ${active ? 'chip-active' : ''}`} style={width ? { maxWidth: width } : undefined}>
      <span className={active ? 'font-medium' : 'text-[var(--text-secondary)]'}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="max-w-[9rem] cursor-pointer appearance-none truncate bg-transparent pr-0.5 text-[length:var(--t-sm)] font-medium text-inherit outline-none"
      >
        {children}
      </select>
      <ChevronDown size={13} />
    </label>
  )
}

export function FilterBar({
  filters,
  onFilters,
  allTypes,
  totalCount,
  shownCount,
  rangeFrom,
  rangeTo,
  unit,
}: {
  filters: Filters
  onFilters: (next: Filters) => void
  allTypes: readonly string[]
  totalCount: number
  shownCount: number
  rangeFrom: number
  rangeTo: number
  unit: string
}) {
  const hasDateRange = filters.dateFrom !== '' || filters.dateTo !== ''

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3 pt-4">
        {/* status segments — the dashboard's primary narrowing */}
        <div className="flex flex-wrap items-center gap-1">
          {CATEGORIES.map((c) => {
            const active = filters.category === c.key
            return (
              <button
                key={c.key}
                onClick={() => onFilters({ ...filters, category: c.key })}
                aria-pressed={active}
                className={`rounded-[var(--r-control)] px-3 py-1.5 text-[length:var(--t-base)] transition-colors duration-[var(--dur)] ${
                  active ? 'bg-[var(--neutral-bg)] font-semibold text-[var(--text)]' : 'font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                }`}
              >
                {c.label}
              </button>
            )
          })}
        </div>

        <div className="flex min-w-[17rem] flex-1 items-center gap-2 rounded-[var(--r-control)] border border-[var(--border-strong)] bg-[var(--surface)] pl-2.5 pr-2 transition-shadow duration-[var(--dur)] focus-within:border-[var(--blue)] focus-within:shadow-[0_0_0_3px_var(--blue-bg)] sm:max-w-[24rem] sm:flex-none">
          <span className="text-[var(--text-muted)]">
            <SearchIcon size={14} />
          </span>
          <input
            value={filters.search}
            onChange={(e) => onFilters({ ...filters, search: e.target.value })}
            placeholder="Search"
            aria-label="Search the trail"
            className="min-w-0 flex-1 bg-transparent py-2 text-[length:var(--t-base)] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          />
          {filters.search && (
            <button
              onClick={() => onFilters({ ...filters, search: '' })}
              aria-label="Clear search"
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--text)]"
            >
              <XIcon size={11} />
            </button>
          )}
          <span className="flex items-center gap-1 border-l border-[var(--border)] pl-2 text-[length:var(--t-sm)] text-[var(--text-muted)]">
            in
            <select
              value={filters.searchField}
              onChange={(e) => onFilters({ ...filters, searchField: e.target.value as SearchField })}
              aria-label="Search field"
              className="cursor-pointer appearance-none bg-transparent font-medium text-[var(--text)] outline-none"
            >
              {(Object.keys(SEARCH_FIELD_LABEL) as SearchField[]).map((f) => (
                <option key={f} value={f}>
                  {SEARCH_FIELD_LABEL[f]}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </span>
        </div>
      </div>

      {/* filter chips */}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <span className={`chip ${hasDateRange ? 'chip-active' : ''}`}>
          <span className={hasDateRange ? 'font-medium' : 'text-[var(--text-secondary)]'}>Date range:</span>
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => onFilters({ ...filters, dateFrom: e.target.value })}
            aria-label="From date"
            className="bg-transparent text-[length:var(--t-sm)] text-inherit outline-none [color-scheme:light]"
          />
          <span className="text-[var(--text-muted)]" aria-hidden>
            –
          </span>
          <input
            type="date"
            value={filters.dateTo}
            onChange={(e) => onFilters({ ...filters, dateTo: e.target.value })}
            aria-label="To date"
            className="bg-transparent text-[length:var(--t-sm)] text-inherit outline-none [color-scheme:light]"
          />
          {hasDateRange && (
            <button
              onClick={() => onFilters({ ...filters, dateFrom: '', dateTo: '' })}
              aria-label="Clear date range"
              className="ml-0.5 text-[var(--text-muted)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--text)]"
            >
              <XIcon size={11} />
            </button>
          )}
        </span>

        <SelectChip
          label="Enforcement"
          value={filters.enforcement}
          active={filters.enforcement !== 'all'}
          onChange={(v) => onFilters({ ...filters, enforcement: v as Filters['enforcement'] })}
        >
          <option value="all">Any</option>
          {(Object.keys(ENFORCEMENT_LABEL) as BoundEnforcer[]).map((k) => (
            <option key={k} value={k}>
              {ENFORCEMENT_LABEL[k]}
            </option>
          ))}
        </SelectChip>

        <label className={`chip cursor-pointer ${filters.types.size > 0 ? 'chip-active' : ''}`}>
          <span className={filters.types.size > 0 ? 'font-medium' : 'text-[var(--text-secondary)]'}>Event type</span>
          <select
            value=""
            onChange={(e) => {
              if (!e.target.value) return
              const next = new Set(filters.types)
              if (next.has(e.target.value)) next.delete(e.target.value)
              else next.add(e.target.value)
              onFilters({ ...filters, types: next })
            }}
            aria-label="Event type"
            className="max-w-[11rem] cursor-pointer appearance-none truncate bg-transparent text-[length:var(--t-sm)] font-medium text-inherit outline-none"
          >
            <option value="">{filters.types.size > 0 ? `${filters.types.size} selected` : 'Any'}</option>
            {allTypes.map((t) => (
              <option key={t} value={t}>
                {filters.types.has(t) ? '✓ ' : ''}
                {t}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </label>

        {filters.types.size > 0 && (
          <button onClick={() => onFilters({ ...filters, types: new Set() })} className="link text-[length:var(--t-sm)]">
            Clear types
          </button>
        )}
      </div>

      <div className="px-4 pb-3 text-[length:var(--t-sm)] text-[var(--text-secondary)]">
        {totalCount === 0 ? (
          `No ${unit}`
        ) : (
          <>
            Showing {rangeFrom.toLocaleString('en-IN')}–{rangeTo.toLocaleString('en-IN')} of {shownCount.toLocaleString('en-IN')} {unit}
            {shownCount !== totalCount && <span className="text-[var(--text-muted)]"> (filtered from {totalCount.toLocaleString('en-IN')})</span>}
          </>
        )}
      </div>
    </div>
  )
}
