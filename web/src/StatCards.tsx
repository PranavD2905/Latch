import type { RunningTotals } from './totals'
import { formatRupees } from './types'

function RefundIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  )
}
function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z" />
    </svg>
  )
}
function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}
function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function MiniCard({
  icon,
  label,
  value,
  sub,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: React.ReactNode
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-1 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition hover:border-[var(--border-strong)] hover:shadow-sm"
    >
      <div className="flex items-center justify-between text-[var(--text-muted)]">
        <span className="flex items-center gap-1.5 text-[13px] font-medium">
          {icon}
          {label}
        </span>
        <ChevronIcon />
      </div>
      <div className="font-mono text-2xl font-semibold tabular-nums text-[var(--text)]">{value}</div>
      <div className="text-[13px] text-[var(--text-muted)]">{sub}</div>
    </button>
  )
}

export function StatCards({
  totals,
  refusalCount,
  bookingCount,
  onFilterRefusals,
}: {
  totals: RunningTotals
  refusalCount: number
  bookingCount: number
  onFilterRefusals: () => void
}) {
  const zero = totals.netCustomerCostPaise === 0

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-muted)]">
          Net customer cost
          <span title="Deposits + no-show charges, net of refunds — must land on ₹0 after a merchant decline.">ⓘ</span>
        </div>
        <div className={`mt-1 font-mono text-5xl font-semibold tabular-nums ${zero ? 'text-[var(--good-text)]' : 'text-[var(--text)]'}`}>
          {formatRupees(totals.netCustomerCostPaise)}
        </div>
        <div className="mt-2 text-[13px] text-[var(--text-muted)]">
          from {bookingCount} booking{bookingCount === 1 ? '' : 's'} in the trail{zero && bookingCount > 0 ? ' — fully unwound, nothing collected' : ''}
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <MiniCard
          icon={<RefundIcon />}
          label="Merchant retention"
          value={formatRupees(totals.netMerchantRetentionPaise)}
          sub="kept from cancellations + no-shows"
        />
        <MiniCard
          icon={<AlertIcon />}
          label="Refusals"
          value={String(refusalCount)}
          sub={refusalCount > 0 ? 'bounds demonstrated, not just claimed' : '0 attempted breaches'}
          onClick={onFilterRefusals}
        />
        <MiniCard
          icon={<ShieldIcon />}
          label="Authorisation headroom"
          value={formatRupees(totals.authorizationHeadroomPaise)}
          sub="across every still-open authorisation"
        />
      </div>
    </div>
  )
}
