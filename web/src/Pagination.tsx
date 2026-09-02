import { useMemo } from 'react'
import { ChevronLeft, ChevronRight } from './icons'

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const

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

  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3" aria-label={`${label} pagination`}>
      <label className="flex items-center gap-2 text-[length:var(--t-sm)] text-[var(--text-secondary)]">
        Rows per page
        <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))} className="control w-auto cursor-pointer py-1">
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(clampedPage - 1)}
          disabled={clampedPage === 1}
          className="flex h-7 w-7 items-center justify-center rounded-[var(--r-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] transition-colors duration-[var(--dur)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
          aria-label="Previous page"
        >
          <ChevronLeft size={13} />
        </button>

        {windowed.map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`e${i}`} className="px-1 text-[length:var(--t-sm)] text-[var(--text-muted)]" aria-hidden>
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              aria-current={p === clampedPage ? 'page' : undefined}
              className={`flex h-7 min-w-7 items-center justify-center rounded-[var(--r-control)] px-2 text-[length:var(--t-sm)] tabular-nums transition-colors duration-[var(--dur)] ${
                p === clampedPage
                  ? 'border border-[var(--blue)] bg-[var(--blue-bg)] font-semibold text-[var(--blue-hover)]'
                  : 'border border-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
              }`}
            >
              {p}
            </button>
          ),
        )}

        <button
          onClick={() => onPageChange(clampedPage + 1)}
          disabled={clampedPage === pageCount}
          className="flex h-7 w-7 items-center justify-center rounded-[var(--r-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] transition-colors duration-[var(--dur)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
          aria-label="Next page"
        >
          <ChevronRight size={13} />
        </button>
      </div>
    </nav>
  )
}
