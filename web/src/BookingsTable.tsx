import { useMemo } from 'react'
import { paginate } from './Pagination'
import { computeTotals } from './totals'
import type { BookingEvent } from './types'
import { bookingStatusLabel, formatRupeesFixed, shortId } from './types'
import { CheckCircleIcon, InfoCircleIcon } from './icons'

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })
}

const TONE: Record<string, { bg: string; text: string; good: boolean }> = {
  good: { bg: 'var(--good-bg)', text: 'var(--good-text)', good: true },
  warning: { bg: 'var(--warning-bg)', text: 'var(--warning-text)', good: false },
  critical: { bg: 'var(--critical-bg)', text: 'var(--critical-text)', good: false },
  neutral: { bg: 'var(--neutral-bg)', text: 'var(--neutral-text)', good: false },
  blue: { bg: 'var(--blue-bg)', text: 'var(--blue-hover)', good: false },
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

/** Rows are derived here so the caller can page and count them without recomputing the grouping. */
export function useBookingRows(events: readonly BookingEvent[]): BookingRow[] {
  return useMemo(() => groupByBooking(events), [events])
}

export function BookingsTable({ rows, page, pageSize }: { rows: readonly BookingRow[]; page: number; pageSize: number }) {
  const pageRows = paginate(rows, page, pageSize)

  return (
    <div className="overflow-x-auto">
      <table className="grid-table">
        <thead>
          <tr>
            <th className="edge-l">Booking ID</th>
            <th>Practitioner / service</th>
            <th>Events</th>
            <th>Started</th>
            <th>Last activity</th>
            <th className="text-right">Net customer cost</th>
            <th className="edge-r">Status</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row) => {
            const tone = TONE[row.status.tone]!
            return (
              <tr key={row.bookingId} className="rowlink">
                <td className="edge-l whitespace-nowrap text-[length:var(--t-base)] font-medium text-[var(--text)]" title={row.bookingId}>
                  {shortId(row.bookingId)}
                </td>
                <td className="text-[length:var(--t-sm)] text-[var(--text-secondary)]">
                  {/* A booking whose trail never included HOLD_CREATED has neither field; one dash reads better than two stacked ones. */}
                  {row.practitionerId || row.serviceId ? (
                    <>
                      {shortId(row.practitionerId)}
                      <div className="text-[var(--text-muted)]">{shortId(row.serviceId)}</div>
                    </>
                  ) : (
                    <span className="text-[var(--text-muted)]">—</span>
                  )}
                </td>
                <td className="text-[length:var(--t-sm)] tabular-nums text-[var(--text-secondary)]">{row.eventCount}</td>
                <td className="whitespace-nowrap text-[length:var(--t-sm)] text-[var(--text-secondary)]">{timeLabel(row.startedAt)}</td>
                <td className="whitespace-nowrap text-[length:var(--t-sm)] text-[var(--text-secondary)]">{timeLabel(row.lastActivityAt)}</td>
                <td
                  className="whitespace-nowrap text-right text-[length:var(--t-base)] font-medium tabular-nums"
                  style={{ color: row.netCustomerCostPaise === 0 ? 'var(--good-text)' : 'var(--text)' }}
                >
                  {formatRupeesFixed(row.netCustomerCostPaise)}
                </td>
                <td className="edge-r">
                  <span className="pill" style={{ background: tone.bg, color: tone.text }}>
                    {tone.good ? <CheckCircleIcon size={12} /> : <InfoCircleIcon size={12} />}
                    {row.status.label}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
