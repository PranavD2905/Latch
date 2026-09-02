import { Fragment, useState } from 'react'
import { EnforcedByBadge } from './EnforcedByBadge'
import { paginate, Pagination } from './Pagination'
import { RAZORPAY_MDR_RATE } from './totals'
import type { BookingEvent, BoundEnforcer } from './types'
import { eventCategory, formatRupees, shortId } from './types'

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** The long-form label the expanded panel and tooltips use — the table itself has no room for a weekday. */
function fullTimeLabel(iso: string): string {
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
      return `no-show ceiling · rail=${event['rail']} · lapses ${timeLabel(event['expiresAt'] as string)}`
    case 'SESSION_COMPLETE_AUTHORIZATION_HELD':
      return `session-complete mandate · rail=${event['rail']} · lapses ${timeLabel(event['expiresAt'] as string)}`
    case 'SESSION_COMPLETE_AUTHORIZATION_RELEASED':
      return `${shortId(event['authorizationId'] as string)} abandoned — auto-expires ${timeLabel(event['expiresAt'] as string)}`
    case 'SESSION_COMPLETE_AUTHORIZATION_LAPSED':
      return `${shortId(event['authorizationId'] as string)} — 5-day window expired`
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
    // The money events carried no synopsis at all and rendered an empty
    // cell — the busiest rows in the table were the least readable ones.
    case 'DEPOSIT_CAPTURED':
      return `deposit taken up front · ${event.action ? event.action.instrument : 'unknown instrument'}`
    case 'RETENTION_APPLIED':
      return `ladder tier applied — merchant keeps ${formatRupees(event.action?.amountPaise ?? 0)}`
    case 'REFUND_ISSUED':
      return `returned to the patient${event.authority?.razorpayRefundId ? ` · ${shortId(event.authority.razorpayRefundId)}` : ''}`
    case 'NO_SHOW_CHARGED':
      return 'charged against the no-show authorisation, up to its ceiling'
    case 'SESSION_COMPLETE_CHARGED':
      return 'session-complete mandate captured after attendance'
    case 'RECONCILIATION_MISMATCH':
      return `${String(event['subject'])}: trail said ${String(event['expectedStatus'])}, Razorpay says ${String(event['actualStatus'])} (via ${String(event['detectedVia'])})`
    default:
      return ''
  }
}

function amountCell(event: BookingEvent): { text: string; color: string } | undefined {
  if (event.action) {
    const isCredit = event.action.direction === 'credit'
    return { text: `${formatRupees(event.action.amountPaise)} ${event.action.direction}`, color: isCredit ? 'var(--good-text)' : 'var(--warning-text)' }
  }
  if (event.type === 'AUTHORIZATION_HELD' || event.type === 'SESSION_COMPLETE_AUTHORIZATION_HELD') {
    return { text: `${formatRupees(event['amountPaise'] as number)} ceiling`, color: 'var(--text)' }
  }
  return undefined
}

const CATEGORY_TINT: Record<string, string> = {
  money: 'var(--accent)',
  refused: 'var(--critical)',
  lifecycle: 'var(--text-faint)',
}

function ChevronToggle({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="transition-transform duration-[var(--dur)] ease-[var(--ease-out-quart)]"
      style={{ transform: open ? 'rotate(180deg)' : 'none' }}
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** One labelled fact inside the proof panel. Label above, value below, hairline-separated — the same shape for all four slots. */
function ProofSlot({ tag, label, children }: { tag: string; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[10px] font-bold tracking-[0.08em] text-[var(--text-faint)]">{tag}</span>
        <span className="text-[length:var(--t-2xs)] font-semibold uppercase tracking-[0.06em] text-[var(--text-faint)]">{label}</span>
      </div>
      <div className="mt-1 font-mono text-[length:var(--t-xs)] leading-relaxed text-[var(--text)]">{children}</div>
    </div>
  )
}

/**
 * The expanded row. For a money event this is the whole point of the
 * product rendered as one object: the action taken, the authority it was
 * taken under, the bound it stayed inside, and the gate it cleared — four
 * facts recorded at the time, not reconstructed afterwards.
 */
function DetailPanel({ event }: { event: BookingEvent }) {
  if (event.type === 'ACTION_REFUSED') {
    return (
      <div className="rounded-lg bg-[var(--critical-bg)] p-4 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--critical)_28%,transparent)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-[var(--critical-text)] px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-[0.08em] text-white">REFUSED</span>
          <span className="font-mono text-[length:var(--t-sm)] font-semibold text-[var(--critical-text)]">
            {String(event['attemptedType'])} → {String(event['refusalCode'])}
          </span>
        </div>
        <div className="mt-2 max-w-[80ch] font-mono text-[length:var(--t-xs)] leading-relaxed text-[var(--critical-text)] opacity-85">{String(event['reason'])}</div>
        <div className="mt-2.5 border-t border-[color-mix(in_oklab,var(--critical)_22%,transparent)] pt-2.5 text-[length:var(--t-xs)] text-[var(--critical-text)] opacity-80">
          The attempt is recorded exactly like a successful one. A bound that only stops things silently can&apos;t be audited.
        </div>
      </div>
    )
  }

  if (event.action && event.gate && event.bound && event.authority) {
    return (
      <div className="rounded-lg bg-[var(--paper)] p-4 shadow-[inset_0_0_0_1px_var(--line)]">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
          <span className="text-[length:var(--t-xs)] font-medium text-[var(--text-muted)]">Recorded at the moment of the action</span>
          <EnforcedByBadge enforcedBy={event.bound.enforcedBy} />
        </div>
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
          <ProofSlot tag="B1" label="Action">
            {formatRupees(event.action.amountPaise)} {event.action.direction}
            <span className="text-[var(--text-muted)]"> via {event.action.instrument}</span>
          </ProofSlot>
          <ProofSlot tag="B2" label="Authority">
            policy v{event.authority.policyVersion}
            {event.authority.authorizationId && <div className="text-[var(--text-muted)]">{shortId(event.authority.authorizationId)}</div>}
            {event.authority.razorpayPaymentId && <div className="text-[var(--text-muted)]">{shortId(event.authority.razorpayPaymentId)}</div>}
            {event.authority.razorpayRefundId && <div className="text-[var(--text-muted)]">{shortId(event.authority.razorpayRefundId)}</div>}
          </ProofSlot>
          <ProofSlot tag="B3" label="Bound">
            ceiling {formatRupees(event.bound.ceilingPaise)}
            <div className="text-[var(--text-muted)]">headroom after {formatRupees(event.bound.headroomAfterPaise)}</div>
          </ProofSlot>
          <ProofSlot tag="B4" label="Gate cleared">
            {event.gate.cleared.length === 0 ? <span className="text-[var(--text-muted)]">—</span> : event.gate.cleared.join(' + ')}
          </ProofSlot>
        </div>
        {event.type === 'REFUND_ISSUED' && (
          // docs/05-cost-model.md's "−₹7.08 sunk MDR" made live: the platform
          // fee charged at capture is never reversed on a refund, whatever the
          // reason for the refund.
          <div className="mt-3 flex items-start gap-2 rounded-md bg-[var(--warning-bg)] px-3 py-2 text-[length:var(--t-xs)] leading-relaxed text-[var(--warning-text)]">
            <span aria-hidden>⚠</span>
            <span>
              MDR <span className="font-mono font-semibold">{formatRupees(Math.round(event.action.amountPaise * RAZORPAY_MDR_RATE))}</span> is not recovered on
              a refund — borne by the merchant.
            </span>
          </div>
        )}
      </div>
    )
  }

  if (event.type === 'AUTHORIZATION_HELD' || event.type === 'SESSION_COMPLETE_AUTHORIZATION_HELD') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--paper)] p-4 shadow-[inset_0_0_0_1px_var(--line)]">
        <span className="max-w-[74ch] font-mono text-[length:var(--t-xs)] leading-relaxed text-[var(--text-muted)]">
          {event.type === 'SESSION_COMPLETE_AUTHORIZATION_HELD' ? 'session-complete mandate' : 'no-show ceiling'} registered:{' '}
          <span className="font-semibold text-[var(--text)]">{formatRupees(event['amountPaise'] as number)}</span> — the authorised amount IS the ceiling, so
          there is no headroom to abuse.
        </span>
        <EnforcedByBadge enforcedBy="payment_rail" />
      </div>
    )
  }

  return (
    <div className="rounded-lg bg-[var(--paper)] p-4 font-mono text-[length:var(--t-xs)] leading-relaxed text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--line)]">
      {synopsis(event) || 'No additional detail recorded for this event type.'}
    </div>
  )
}

export function EventsTable({
  events,
  arrivals,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  events: readonly BookingEvent[]
  arrivals: ReadonlySet<string>
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const pageEvents = paginate(events, page, pageSize)

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="ledger">
          <thead>
            <tr>
              <th className="cell-edge-l">Event</th>
              <th>Booking</th>
              <th>Detail</th>
              <th>Occurred</th>
              <th className="text-right">Amount</th>
              <th>Enforcement</th>
              <th className="cell-edge-r" />
            </tr>
          </thead>
          <tbody>
            {pageEvents.map((event) => {
              const category = eventCategory(event)
              const isRefused = category === 'refused'
              const amount = amountCell(event)
              const isOpen = expanded === event.eventId
              const isNew = arrivals.has(event.eventId)
              const enforcedBy: BoundEnforcer | undefined =
                event.bound?.enforcedBy ?? (event.type === 'AUTHORIZATION_HELD' || event.type === 'SESSION_COMPLETE_AUTHORIZATION_HELD' ? 'payment_rail' : undefined)

              return (
                <Fragment key={event.eventId}>
                  <tr
                    className={`row-hoverable ${isOpen ? 'row-open' : ''} ${isNew ? 'row-arrive' : ''}`}
                    style={
                      {
                        '--arrive-tint': `color-mix(in oklab, ${CATEGORY_TINT[category]} 16%, transparent)`,
                        ...(isRefused ? { background: 'var(--critical-bg)' } : null),
                      } as React.CSSProperties
                    }
                  >
                    <td className="cell-edge-l">
                      <span className="flex items-center gap-2.5">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CATEGORY_TINT[category] }} aria-hidden />
                        <span
                          className="font-mono text-[length:var(--t-sm)] font-semibold tracking-[-0.01em]"
                          style={{ color: isRefused ? 'var(--critical-text)' : 'var(--text)' }}
                        >
                          {event.type}
                        </span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap font-mono text-[length:var(--t-xs)] text-[var(--text-muted)]" title={event.bookingId}>
                      {shortId(event.bookingId)}
                    </td>
                    <td className="max-w-[220px] truncate text-[length:var(--t-xs)] text-[var(--text-muted)]" title={synopsis(event)}>
                      {synopsis(event)}
                    </td>
                    <td className="whitespace-nowrap font-mono text-[length:var(--t-xs)] text-[var(--text-muted)]" title={fullTimeLabel(event.occurredAt)}>
                      {timeLabel(event.occurredAt)}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono text-[length:var(--t-sm)] font-semibold tabular-nums" style={{ color: amount?.color ?? 'var(--text-faint)' }}>
                      {amount?.text ?? '—'}
                    </td>
                    <td>
                      {isRefused ? (
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--critical-text)] px-2 py-1 font-mono text-[10px] font-bold tracking-[0.08em] text-white">
                          REFUSED
                        </span>
                      ) : enforcedBy ? (
                        <EnforcedByBadge enforcedBy={enforcedBy} compact />
                      ) : (
                        <span className="text-[var(--text-faint)]">—</span>
                      )}
                    </td>
                    <td className="cell-edge-r text-right">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : event.eventId)}
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? 'Hide' : 'Show'} recorded proof for ${event.type}`}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[length:var(--t-xs)] font-medium text-[var(--accent-text)] transition-colors duration-[var(--dur)] hover:bg-[var(--accent-bg)]"
                      >
                        Proof
                        <ChevronToggle open={isOpen} />
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={7} className="cell-edge-l cell-edge-r bg-[var(--paper-sunk)] !py-4">
                        <div className="detail-open">
                          <DetailPanel event={event} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={pageSize} totalCount={events.length} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} label="events" />
    </div>
  )
}
