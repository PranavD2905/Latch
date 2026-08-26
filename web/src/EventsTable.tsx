import { Fragment, useState } from 'react'
import { EnforcedByBadge } from './EnforcedByBadge'
import { StatusIcon } from './StatusIcon'
import { RAZORPAY_MDR_RATE } from './totals'
import type { BookingEvent, BoundEnforcer } from './types'
import { eventCategory, formatRupees, shortId } from './types'

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function synopsis(event: BookingEvent): string {
  switch (event.type) {
    case 'HOLD_CREATED':
      return `held · practitioner=${shortId(event['practitionerId'] as string)} · ttl=${event['ttlSeconds']}s`
    case 'HOLD_EXPIRED':
      return 'TTL elapsed — slot returned to inventory'
    case 'HOLD_RELEASED':
      return `released by ${event['releasedBy']}`
    case 'POLICY_ACKNOWLEDGED':
      return `agent acknowledged ladder v${event['policyVersion']}`
    case 'AUTHORIZATION_HELD':
      return `rail=${event['rail']} · lapses ${timeLabel(event['expiresAt'] as string)}`
    case 'BOOKING_CONFIRMED':
      return 'deposit + authorisation both succeeded'
    case 'BOOKING_RESCHEDULED':
      return `moved ${timeLabel(event['previousStartsAt'] as string)} → ${timeLabel(event['newStartsAt'] as string)}`
    case 'CANCELLED_BY_CUSTOMER':
      return 'customer-initiated cancellation'
    case 'MERCHANT_DECLINED':
      return `reason=${event['reason']} · cause=MERCHANT → ladder NOT applied`
    case 'SLOT_RELEASED':
      return `practitioner=${shortId(event['practitionerId'] as string)} returned to inventory`
    case 'AUTHORIZATION_RELEASED':
      return `${shortId(event['authorizationId'] as string)} abandoned — auto-expires ${timeLabel(event['expiresAt'] as string)}`
    case 'AUTHORIZATION_LAPSED':
      return `${shortId(event['authorizationId'] as string)} — 5-day window expired`
    case 'ALTERNATIVES_OFFERED': {
      const alts = (event['alternatives'] as unknown[] | undefined) ?? []
      return `${alts.length} replacement slot${alts.length === 1 ? '' : 's'} computed by calendar query`
    }
    case 'NO_SHOW_ELIGIBLE':
      return 'start + grace elapsed — charge is now permissible, not automatic'
    case 'NON_ATTENDANCE_MARKED':
      return 'merchant API only — no agent-facing path can forge this'
    case 'BOOKING_COMPLETED':
      return 'merchant marked attendance'
    case 'ACTION_REFUSED':
      return `${String(event['attemptedType'])} → ${String(event['refusalCode'])}`
    case 'RECONCILIATION_MISMATCH':
      return `${String(event['subject'])}: trail said ${String(event['expectedStatus'])}, Razorpay says ${String(event['actualStatus'])} (via ${String(event['detectedVia'])})`
    default:
      return ''
  }
}

function amountCell(event: BookingEvent): { text: string; className: string } | undefined {
  if (event.action) {
    const isCredit = event.action.direction === 'credit'
    return { text: `${formatRupees(event.action.amountPaise)} ${event.action.direction}`, className: isCredit ? 'text-[var(--good-text)]' : 'text-[var(--warning-text)]' }
  }
  if (event.type === 'AUTHORIZATION_HELD') {
    return { text: `${formatRupees(event['amountPaise'] as number)} ceiling`, className: 'text-[var(--text)]' }
  }
  return undefined
}

const CATEGORY_DOT: Record<string, string> = { money: 'bg-[var(--blue)]', refused: 'bg-[var(--critical)]', lifecycle: 'bg-[var(--text-faint)]' }

function DetailPanel({ event }: { event: BookingEvent }) {
  if (event.type === 'ACTION_REFUSED') {
    return (
      <div className="space-y-1.5 rounded-lg bg-[var(--critical-bg)] p-4">
        <div className="font-mono text-sm font-bold text-[var(--critical-text)]">
          refused: {String(event['attemptedType'])} → {String(event['refusalCode'])}
        </div>
        <div className="font-mono text-xs text-[var(--critical-text)]/80">{String(event['reason'])}</div>
      </div>
    )
  }

  if (event.action && event.gate && event.bound && event.authority) {
    return (
      <div className="space-y-3 rounded-lg bg-[var(--bg)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1.5 font-mono text-[12px] text-[var(--text-muted)]">
            <div>
              <span className="text-[var(--text-faint)]">B1 action</span> {formatRupees(event.action.amountPaise)} {event.action.direction} via {event.action.instrument}
            </div>
            <div>
              <span className="text-[var(--text-faint)]">B4 gate</span> {event.gate.cleared.join(' + ')}
            </div>
            <div>
              <span className="text-[var(--text-faint)]">B3 bound</span> ceiling {formatRupees(event.bound.ceilingPaise)} · headroom after {formatRupees(event.bound.headroomAfterPaise)}
            </div>
            <div>
              <span className="text-[var(--text-faint)]">B2 authority</span> policy v{event.authority.policyVersion}
              {event.authority.authorizationId ? ` · ${shortId(event.authority.authorizationId)}` : ''}
              {event.authority.razorpayPaymentId ? ` · ${shortId(event.authority.razorpayPaymentId)}` : ''}
              {event.authority.razorpayRefundId ? ` · ${shortId(event.authority.razorpayRefundId)}` : ''}
            </div>
            {event.type === 'REFUND_ISSUED' && (
              // dev-logs/014, item 5 — docs/05-cost-model.md's "−₹7.08 sunk
              // MDR" made live: the platform fee charged at capture is never
              // reversed on a refund, regardless of why the refund happened.
              <div className="text-[var(--warning-text)]">
                <span className="text-[var(--text-faint)]">note</span> MDR {formatRupees(Math.round(event.action.amountPaise * RAZORPAY_MDR_RATE))} not
                recovered — borne by merchant
              </div>
            )}
          </div>
          <EnforcedByBadge enforcedBy={event.bound.enforcedBy} />
        </div>
      </div>
    )
  }

  if (event.type === 'AUTHORIZATION_HELD') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--bg)] p-4">
        <span className="font-mono text-xs text-[var(--text-muted)]">
          ceiling registered: <span className="font-bold text-[var(--text)]">{formatRupees(event['amountPaise'] as number)}</span> — the authorised amount IS
          the ceiling, no headroom to abuse
        </span>
        <EnforcedByBadge enforcedBy="payment_rail" />
      </div>
    )
  }

  return <div className="rounded-lg bg-[var(--bg)] p-4 font-mono text-xs text-[var(--text-muted)]">{synopsis(event)}</div>
}

export function EventsTable({ events }: { events: readonly BookingEvent[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-[var(--border)] text-[12px] text-[var(--text-muted)]">
            <th className="px-6 py-2.5 font-medium">Event</th>
            <th className="px-3 py-2.5 font-medium">Booking</th>
            <th className="px-3 py-2.5 font-medium">Detail</th>
            <th className="px-3 py-2.5 font-medium">Occurred on</th>
            <th className="px-3 py-2.5 font-medium">Amount</th>
            <th className="px-3 py-2.5 font-medium">Enforcement</th>
            <th className="px-6 py-2.5 font-medium" />
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const category = eventCategory(event)
            const isRefused = category === 'refused'
            const amount = amountCell(event)
            const isOpen = expanded === event.eventId
            const enforcedBy: BoundEnforcer | undefined = event.bound?.enforcedBy ?? (event.type === 'AUTHORIZATION_HELD' ? 'payment_rail' : undefined)

            return (
              <Fragment key={event.eventId}>
                <tr className="border-b border-[var(--border)] hover:bg-[var(--bg)]">
                  <td className="px-6 py-3">
                    <span className="flex items-center gap-2 font-mono font-semibold text-[var(--text)]">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CATEGORY_DOT[category]}`} />
                      {isRefused && '⛔ '}
                      {event.type}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-mono text-[var(--text-muted)]">{shortId(event.bookingId)}</td>
                  <td className="max-w-[280px] truncate px-3 py-3 text-[var(--text-muted)]">{synopsis(event)}</td>
                  <td className="px-3 py-3 whitespace-nowrap font-mono text-[var(--text-muted)]">{timeLabel(event.occurredAt)}</td>
                  <td className={`px-3 py-3 whitespace-nowrap font-mono font-semibold ${amount?.className ?? 'text-[var(--text-faint)]'}`}>
                    {amount?.text ?? '—'}
                  </td>
                  <td className="px-3 py-3">
                    {isRefused ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--critical-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--critical-text)]">
                        <StatusIcon />
                        Refused
                      </span>
                    ) : enforcedBy ? (
                      <EnforcedByBadge enforcedBy={enforcedBy} compact />
                    ) : (
                      <span className="text-[var(--text-faint)]">—</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <button
                      onClick={() => setExpanded(isOpen ? null : event.eventId)}
                      className="font-medium text-[var(--blue)] hover:underline"
                    >
                      Details {isOpen ? '⌃' : '›'}
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-[var(--border)]">
                    <td colSpan={7} className="bg-[var(--bg)]/60 px-6 py-4">
                      <DetailPanel event={event} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
