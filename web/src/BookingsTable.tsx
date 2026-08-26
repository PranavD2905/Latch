import { useMemo } from 'react'
import { StatusIcon } from './StatusIcon'
import { computeTotals } from './totals'
import type { BookingEvent } from './types'
import { bookingStatusLabel, formatRupees, shortId } from './types'

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

const TONE_CLASS: Record<string, string> = {
  good: 'bg-[var(--good-bg)] text-[var(--good-text)]',
  warning: 'bg-[var(--warning-bg)] text-[var(--warning-text)]',
  critical: 'bg-[var(--critical-bg)] text-[var(--critical-text)]',
  neutral: 'bg-[var(--slate-bg)] text-[var(--slate)]',
  blue: 'bg-[var(--blue-bg)] text-[var(--blue-text)]',
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

export function BookingsTable({ events }: { events: readonly BookingEvent[] }) {
  const rows = useMemo(() => groupByBooking(events), [events])

  return (
    <div className="overflow-x-auto">
      <div className="px-6 pb-3 pt-4 text-[13px] text-[var(--text-muted)]">
        Showing {rows.length} booking{rows.length === 1 ? '' : 's'}
      </div>
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-[var(--border)] text-[12px] text-[var(--text-muted)]">
            <th className="px-6 py-2.5 font-medium">Booking ID</th>
            <th className="px-3 py-2.5 font-medium">Practitioner / service</th>
            <th className="px-3 py-2.5 font-medium">Events</th>
            <th className="px-3 py-2.5 font-medium">Started</th>
            <th className="px-3 py-2.5 font-medium">Last activity</th>
            <th className="px-3 py-2.5 font-medium">Net customer cost</th>
            <th className="px-6 py-2.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.bookingId} className="border-b border-[var(--border)] hover:bg-[var(--bg)]">
              <td className="px-6 py-3 font-mono font-semibold text-[var(--text)]">{shortId(row.bookingId)}</td>
              <td className="px-3 py-3 font-mono text-[var(--text-muted)]">
                {shortId(row.practitionerId)} · {shortId(row.serviceId)}
              </td>
              <td className="px-3 py-3 tabular-nums text-[var(--text-muted)]">{row.eventCount}</td>
              <td className="px-3 py-3 whitespace-nowrap font-mono text-[var(--text-muted)]">{timeLabel(row.startedAt)}</td>
              <td className="px-3 py-3 whitespace-nowrap font-mono text-[var(--text-muted)]">{timeLabel(row.lastActivityAt)}</td>
              <td className="px-3 py-3 font-mono font-semibold text-[var(--text)]">{formatRupees(row.netCustomerCostPaise)}</td>
              <td className="px-6 py-3">
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${TONE_CLASS[row.status.tone]}`}>
                  <StatusIcon />
                  {row.status.label}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
