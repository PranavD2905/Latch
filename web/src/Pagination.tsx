import { useMemo } from 'react'

const PAGE_SIZE_OPTIONS = [10, 50, 100] as const

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}
function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** Windowed page list — first, last, current ±1, with ellipses for gaps — so a large trail never renders hundreds of page buttons. */
function pageWindow(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const kept = [...new Set([1, total, current - 1, current, current + 1])].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)
  const result: (number | 'ellipsis')[] = []
  kept.forEach((p, i) => {
    if (i > 0 && p - kept[i - 1]! > 1) result.push('ellipsis')
    result.push(p)
  })
  return result
}

/** Slices `items` to one page — callers pass the same `page`/`pageSize` they hand to <Pagination>, so the two never disagree. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const clamped = Math.min(Math.max(1, page), pageCount)
  const start = (clamped - 1) * pageSize
  return items.slice(start, start + pageSize)
}

export function Pagination({
  page,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
  label,
}: {
  page: number
  pageSize: number
  totalCount: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
  label: string
}) {
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize))
  const clampedPage = Math.min(Math.max(1, page), pageCount)
  const windowed = useMemo(() => pageWindow(clampedPage, pageCount), [clampedPage, pageCount])

  if (totalCount === 0) return null

  const first = (clampedPage - 1) * pageSize + 1
  const last = Math.min(clampedPage * pageSize, totalCount)

  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--paper-sunk)] px-5 py-2.5" aria-label={`${label} pagination`}>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-[length:var(--t-xs)] text-[var(--text-muted)]">
          Rows
          <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))} className="control w-auto cursor-pointer py-1 text-[length:var(--t-xs)]">
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="font-mono text-[length:var(--t-xs)] tabular-nums text-[var(--text-faint)]">
          {first}–{last} of {totalCount}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(clampedPage - 1)}
          disabled={clampedPage === 1}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors duration-[var(--dur)] hover:bg-[var(--paper-deep)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
          aria-label="Previous page"
        >
          <ChevronLeft />
        </button>

        {windowed.map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`e${i}`} className="px-1 text-[length:var(--t-xs)] text-[var(--text-faint)]" aria-hidden>
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              aria-current={p === clampedPage ? 'page' : undefined}
              className={`flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 font-mono text-[length:var(--t-xs)] font-medium tabular-nums transition-colors duration-[var(--dur)] ${
                p === clampedPage ? 'bg-[var(--text)] text-[var(--paper)]' : 'text-[var(--text-muted)] hover:bg-[var(--paper-deep)] hover:text-[var(--text)]'
              }`}
            >
              {p}
            </button>
          ),
        )}

        <button
          onClick={() => onPageChange(clampedPage + 1)}
          disabled={clampedPage === pageCount}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors duration-[var(--dur)] hover:bg-[var(--paper-deep)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
          aria-label="Next page"
        >
          <ChevronRight />
        </button>
      </div>
    </nav>
  )
}
