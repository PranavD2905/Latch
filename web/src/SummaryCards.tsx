import { BlockedIcon, ChevronRight, InfoCircleIcon, RupeeFlowIcon, ShieldIcon } from './icons'
import type { RunningTotals } from './totals'
import { formatRupeesFixed, splitRupees } from './types'

function Info({ text }: { text: string }) {
  return (
    <span className="cursor-help text-[var(--text-muted)]" title={text} aria-label={text}>
      <InfoCircleIcon size={13} />
    </span>
  )
}

/** Rupees large, paise small — the amount treatment the rest of the dashboard uses. */
function Amount({ paise, className }: { paise: number; className?: string }) {
  const { whole, frac } = splitRupees(paise)
  return (
    <span className={`tabular-nums ${className ?? ''}`}>
      {whole}
      <span className="text-[0.62em] font-medium">{frac}</span>
    </span>
  )
}

function MetricCard({
  icon,
  tint,
  title,
  info,
  value,
  caption,
  action,
}: {
  icon: React.ReactNode
  tint: string
  title: string
  info: string
  value: React.ReactNode
  caption: React.ReactNode
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="card flex flex-col p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[length:var(--t-base)] font-semibold text-[var(--text)]">
          <span style={{ color: tint }}>{icon}</span>
          {title}
          <Info text={info} />
        </span>
        {action && (
          <button onClick={action.onClick} className="link flex items-center gap-0.5 text-[length:var(--t-sm)]">
            {action.label}
            <ChevronRight size={13} />
          </button>
        )}
      </div>
      <div className="mt-3.5 text-[length:var(--t-2xl)] font-semibold text-[var(--text)]">{value}</div>
      <div className="mt-1 text-[length:var(--t-sm)] leading-relaxed text-[var(--text-muted)]">{caption}</div>
    </div>
  )
}

export function SummaryCards({
  totals,
  refusalCount,
  bookingCount,
  eventCount,
  onFilterRefusals,
}: {
  totals: RunningTotals
  refusalCount: number
  bookingCount: number
  eventCount: number
  onFilterRefusals: () => void
}) {
  const zero = totals.netCustomerCostPaise === 0 && eventCount > 0

  return (
    <div className="flex flex-col gap-4">
      <div className="card px-6 py-5">
        <div className="flex items-center gap-1.5 text-[length:var(--t-base)] font-semibold text-[var(--text)]">
          Net customer cost
          <Info text="Deposits and no-show charges, net of refunds. Lands on ₹0 after a merchant decline." />
        </div>
        <div
          className="mt-1.5 text-[length:var(--t-figure)] font-semibold leading-none tracking-[-0.02em]"
          style={{ color: zero ? 'var(--good-text)' : 'var(--text)' }}
        >
          <Amount paise={totals.netCustomerCostPaise} />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[length:var(--t-sm)] text-[var(--text-muted)]">
          <span>
            from {bookingCount.toLocaleString('en-IN')} booking{bookingCount === 1 ? '' : 's'} in the trail
          </span>
          {zero && (
            <span className="pill" style={{ background: 'var(--good-bg)', color: 'var(--good-text)' }}>
              Fully unwound — nothing collected
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          icon={<RupeeFlowIcon size={16} />}
          tint="var(--good)"
          title="Merchant retention"
          info="Applied retentions plus no-show charges — what the merchant actually keeps."
          value={<Amount paise={totals.netMerchantRetentionPaise} />}
          caption={
            totals.sunkMdrPaise > 0 ? (
              <>
                kept from cancellations + no-shows ·{' '}
                <span
                  className="font-medium text-[var(--warning-text)]"
                  title="Razorpay's platform fee is charged at capture and never reversed on a refund — docs/05-cost-model.md."
                >
                  −{formatRupeesFixed(totals.sunkMdrPaise)} sunk MDR
                </span>
              </>
            ) : (
              'kept from cancellations + no-shows'
            )
          }
          action={undefined}
        />

        <MetricCard
          icon={<BlockedIcon size={16} />}
          tint="var(--critical)"
          title="Refusals"
          info="Actions an agent attempted and the system refused. Recorded exactly like successful ones."
          value={<span className="tabular-nums">{refusalCount.toLocaleString('en-IN')}</span>}
          caption={refusalCount > 0 ? 'bounds demonstrated, not just claimed' : '0 attempted breaches'}
          action={refusalCount > 0 ? { label: 'View all', onClick: onFilterRefusals } : undefined}
        />

        <MetricCard
          icon={<ShieldIcon size={16} />}
          tint="var(--blue)"
          title="Authorisation headroom"
          info="Ceiling minus captured, summed across every authorisation still open."
          value={<Amount paise={totals.authorizationHeadroomPaise} />}
          caption="across every still-open authorisation"
        />
      </div>
    </div>
  )
}
