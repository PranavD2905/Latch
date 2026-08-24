import { EnforcedByBadge } from './EnforcedByBadge'
import type { BookingEvent, BoundEnforcer } from './types'
import { formatRupees } from './types'

function shortId(id: string | undefined): string {
  if (!id) return '—'
  return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-IN', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** One-line synopsis for event types that carry no MoneyFields — mirrors docs/03-domain-model.md §6's trace prose. */
function synopsis(event: BookingEvent): string {
  switch (event.type) {
    case 'HOLD_CREATED':
      return `slot held · practitioner=${shortId(event['practitionerId'] as string)} · ttl=${event['ttlSeconds']}s`
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
      return `${shortId(event['authorizationId'] as string)} abandoned — never captured, auto-expires ${timeLabel(event['expiresAt'] as string)}`
    case 'AUTHORIZATION_LAPSED':
      return `${shortId(event['authorizationId'] as string)} — 5-day window expired before the appointment`
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
    default:
      return ''
  }
}

const NEUTRAL = 'border-slate-700/70 bg-slate-900/40'
const DECLINE = 'border-amber-500/60 bg-amber-950/20'

function cardClassName(event: BookingEvent): string {
  if (event.type === 'ACTION_REFUSED') return 'border-2 border-rose-500 bg-rose-950/40 shadow-[0_0_20px_rgba(244,63,94,0.25)]'
  if (event.type === 'MERCHANT_DECLINED') return `border ${DECLINE}`
  return `border ${NEUTRAL}`
}

function MoneyLine({ event }: { event: BookingEvent }) {
  const action = event.action!
  const isCredit = action.direction === 'credit'
  return (
    <div className="flex flex-wrap items-center gap-3 rounded bg-black/30 px-3 py-2">
      <span
        className={`font-mono text-lg font-bold tabular-nums ${isCredit ? 'text-emerald-300' : 'text-amber-300'}`}
      >
        {formatRupees(action.amountPaise)}
      </span>
      <span
        className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${
          isCredit ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
        }`}
      >
        {action.direction}
      </span>
      <span className="font-mono text-xs text-slate-400">via {action.instrument}</span>
    </div>
  )
}

export function EventCard({ event }: { event: BookingEvent }) {
  const isRefusal = event.type === 'ACTION_REFUSED'
  const hasMoney = Boolean(event.action && event.bound && event.gate && event.authority)

  return (
    <div className={`rounded-lg p-3 ${cardClassName(event)}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <span className="font-mono text-[11px] text-slate-500">{timeLabel(event.occurredAt)}</span>
          <span
            className={`font-mono text-[13px] font-bold tracking-wide ${
              isRefusal ? 'text-rose-300' : event.type === 'MERCHANT_DECLINED' ? 'text-amber-300' : 'text-slate-100'
            }`}
          >
            {isRefusal ? '⛔ ' : ''}
            {event.type}
          </span>
          <span className="font-mono text-[11px] text-slate-500">{shortId(event.bookingId)}</span>
        </div>
      </div>

      {isRefusal ? (
        <div className="mt-2 space-y-1">
          <div className="font-mono text-sm font-bold text-rose-200">
            refused: {String(event['attemptedType'])} → {String(event['refusalCode'])}
          </div>
          <div className="font-mono text-xs text-rose-300/80">{String(event['reason'])}</div>
        </div>
      ) : (
        <div className="mt-1.5 font-mono text-xs text-slate-400">{synopsis(event)}</div>
      )}

      {hasMoney && (
        <div className="mt-2.5 space-y-2">
          <MoneyLine event={event} />
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1 font-mono text-[11px] text-slate-400">
              <div>
                <span className="text-slate-600">gate</span> {event.gate!.cleared.join(' + ')}
              </div>
              <div>
                <span className="text-slate-600">ceiling</span> {formatRupees(event.bound!.ceilingPaise)} · headroom
                after {formatRupees(event.bound!.headroomAfterPaise)}
              </div>
              <div>
                <span className="text-slate-600">authority</span> policy v{event.authority!.policyVersion}
                {event.authority!.authorizationId ? ` · ${shortId(event.authority!.authorizationId)}` : ''}
                {event.authority!.razorpayPaymentId ? ` · ${shortId(event.authority!.razorpayPaymentId)}` : ''}
                {event.authority!.razorpayRefundId ? ` · ${shortId(event.authority!.razorpayRefundId)}` : ''}
              </div>
            </div>
            <EnforcedByBadge enforcedBy={event.bound!.enforcedBy as BoundEnforcer} />
          </div>
        </div>
      )}

      {/* AUTHORIZATION_HELD isn't a MoneyFields event (no money has moved yet)
          but it's where the no-show ceiling first appears in the trail — "the
          authorised amount IS the ceiling" (docs/03-domain-model.md §6) — so
          it earns the same enforcement badge, not just prose. */}
      {event.type === 'AUTHORIZATION_HELD' && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3 rounded bg-black/30 px-3 py-2">
          <span className="font-mono text-xs text-slate-400">
            ceiling registered: <span className="font-bold text-slate-200">{formatRupees(event['amountPaise'] as number)}</span> — the
            authorised amount IS the ceiling, no headroom to abuse
          </span>
          <EnforcedByBadge enforcedBy="payment_rail" />
        </div>
      )}
    </div>
  )
}
