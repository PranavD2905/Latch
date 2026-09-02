import { useMemo } from 'react'
import { paginate, Pagination } from './Pagination'
import { computeTotals } from './totals'
import type { BookingEvent } from './types'
import { bookingStatusLabel, formatRupees, shortId } from './types'

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

const TONE: Record<string, { bg: string; text: string; dot: string }> = {
  good: { bg: 'var(--good-bg)', text: 'var(--good-text)', dot: 'var(--good)' },
  warning: { bg: 'var(--warning-bg)', text: 'var(--warning-text)', dot: 'var(--warning)' },
  critical: { bg: 'var(--critical-bg)', text: 'var(--critical-text)', dot: 'var(--critical)' },
  neutral: { bg: 'var(--slate-bg)', text: 'var(--slate)', dot: 'var(--text-faint)' },
  blue: { bg: 'var(--accent-bg)', text: 'var(--accent-text)', dot: 'var(--accent)' },
}

interface BookingRow {
  bookingId: string
  practitionerId?: string
  serviceId?: string
  eventCount: number
  startedAt: string
  lastActivityAt: string
  netCustomerCostPaise: number
  status: ReturnType<typeof bookingStatusLabel>
}

function groupByBooking(events: readonly BookingEvent[]): BookingRow[] {
  const byBooking = new Map<string, BookingEvent[]>()
  for (const e of events) {
    const list = byBooking.get(e.bookingId)
    if (list) list.push(e)
    else byBooking.set(e.bookingId, [e])
  }

  const rows: BookingRow[] = []
  for (const [bookingId, bookingEvents] of byBooking) {
    const holdCreated = bookingEvents.find((e) => e.type === 'HOLD_CREATED')
    rows.push({
      bookingId,
      practitionerId: holdCreated?.['practitionerId'] as string | undefined,
      serviceId: holdCreated?.['serviceId'] as string | undefined,
      eventCount: bookingEvents.length,
      startedAt: bookingEvents[0]!.occurredAt,
      lastActivityAt: bookingEvents[bookingEvents.length - 1]!.occurredAt,
      netCustomerCostPaise: computeTotals(bookingEvents).netCustomerCostPaise,
      status: bookingStatusLabel(bookingEvents),
    })
  }
  return rows.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))
}

export function BookingsTable({
  events,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  events: readonly BookingEvent[]
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}) {
  const rows = useMemo(() => groupByBooking(events), [events])
  const pageRows = paginate(rows, page, pageSize)
  const busiest = Math.max(1, ...rows.map((r) => r.eventCount))

  if (rows.length === 0) {
    return (
      <div className="px-6 py-20 text-center">
        <div className="text-[length:var(--t-base)] font-medium text-[var(--text)]">No bookings in this window</div>
        <div className="mt-1 text-[length:var(--t-sm)] text-[var(--text-muted)]">A booking appears here as soon as its first event lands on the trail.</div>
      </div>
    )
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="ledger">
          <thead>
            <tr>
              <th className="cell-edge-l">Booking</th>
              <th>Practitioner / service</th>
              <th>Events</th>
              <th>Started</th>
              <th>Last activity</th>
              <th className="text-right">Net customer cost</th>
              <th className="cell-edge-r">Status</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const tone = TONE[row.status.tone]!
              return (
                <tr key={row.bookingId} className="row-hoverable">
                  <td className="cell-edge-l font-mono text-[length:var(--t-sm)] font-semibold text-[var(--text)]">{shortId(row.bookingId)}</td>
                  <td className="font-mono text-[length:var(--t-xs)] text-[var(--text-muted)]">
                    {shortId(row.practitionerId)} · {shortId(row.serviceId)}
                  </td>
                  <td>
                    {/* the count plus how it compares to the busiest booking — a long trail on one booking usually means a reschedule or a refusal */}
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[length:var(--t-sm)] tabular-nums text-[var(--text-muted)]">{row.eventCount}</span>
                      <span className="h-1 w-10 overflow-hidden rounded-full bg-[var(--paper-deep)]" aria-hidden>
                        <span className="block h-full rounded-full bg-[var(--line-strong)]" style={{ width: `${(row.eventCount / busiest) * 100}%` }} />
                      </span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap font-mono text-[length:var(--t-xs)] text-[var(--text-muted)]">{timeLabel(row.startedAt)}</td>
                  <td className="whitespace-nowrap font-mono text-[length:var(--t-xs)] text-[var(--text-muted)]">{timeLabel(row.lastActivityAt)}</td>
                  <td
                    className="whitespace-nowrap text-right font-mono text-[length:var(--t-sm)] font-semibold tabular-nums"
                    style={{ color: row.netCustomerCostPaise === 0 ? 'var(--good-text)' : 'var(--text)' }}
                  >
                    {formatRupees(row.netCustomerCostPaise)}
                  </td>
                  <td className="cell-edge-r">
                    <span
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[length:var(--t-xs)] font-semibold"
                      style={{ background: tone.bg, color: tone.text }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone.dot }} aria-hidden />
                      {row.status.label}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={pageSize} totalCount={rows.length} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} label="bookings" />
    </div>
  )
}
