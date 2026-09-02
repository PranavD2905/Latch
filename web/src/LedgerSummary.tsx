import type { RunningTotals } from './totals'
import { formatRupees } from './types'

function windowLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * A secondary figure in the statement head. Deliberately not a card: label
 * above, figure below, separated from its neighbours by a hairline rule and
 * nothing else. Three identical bordered boxes would say "dashboard"; a
 * ruled row of figures says "statement", which is what this actually is.
 */
function Figure({
  label,
  value,
  note,
  tone = 'default',
  onClick,
  title,
}: {
  label: string
  value: string
  note: React.ReactNode
  tone?: 'default' | 'critical'
  onClick?: () => void
  title?: string
}) {
  const body = (
    <>
      <div className="text-[length:var(--t-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--on-ink-faint)]">{label}</div>
      <div
        className="mt-1.5 font-mono text-[length:var(--t-xl)] font-semibold tabular-nums tracking-[-0.01em]"
        style={{ color: tone === 'critical' ? 'var(--critical-on-ink)' : 'var(--on-ink)' }}
      >
        {value}
      </div>
      <div className="mt-1 text-[length:var(--t-xs)] leading-snug text-[var(--on-ink-muted)]">{note}</div>
    </>
  )

  if (!onClick) return <div className="min-w-0 flex-1 px-0 py-1 sm:px-5">{body}</div>

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="group min-w-0 flex-1 rounded-lg px-0 py-1 text-left transition-colors duration-[var(--dur)] hover:bg-[var(--ink-raised)] sm:px-5"
    >
      {body}
      <span className="mt-0.5 inline-block text-[length:var(--t-xs)] font-medium text-[var(--accent-on-ink)] opacity-0 transition-opacity duration-[var(--dur)] group-hover:opacity-100 group-focus-visible:opacity-100">
        Filter the trail →
      </span>
    </button>
  )
}

/**
 * The statement head: what the trail adds up to, rendered on the ink shell
 * above the paper. The headline figure is the demo's whole claim — after a
 * merchant decline the customer is out ₹0 — so it gets the size, the tabular
 * mono, and a green reading when it actually lands on zero.
 */
export function LedgerSummary({
  totals,
  refusalCount,
  bookingCount,
  eventCount,
  firstAt,
  lastAt,
  onFilterRefusals,
}: {
  totals: RunningTotals
  refusalCount: number
  bookingCount: number
  eventCount: number
  firstAt?: string
  lastAt?: string
  onFilterRefusals: () => void
}) {
  const zero = totals.netCustomerCostPaise === 0 && eventCount > 0

  return (
    <section className="on-ink px-5 pb-7 pt-6 sm:px-7" aria-label="Trail summary">
      <div className="mx-auto max-w-[1240px]">
        {/* provenance line — what record this is, and over what window */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[length:var(--t-xs)] text-[var(--on-ink-faint)]">
          <span className="text-[var(--on-ink-muted)]">Dr. Rao&apos;s Clinic</span>
          <span aria-hidden>·</span>
          <span>{firstAt && lastAt ? `${windowLabel(firstAt)} → ${windowLabel(lastAt)}` : 'no events recorded yet'}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            {eventCount} event{eventCount === 1 ? '' : 's'} across {bookingCount} booking{bookingCount === 1 ? '' : 's'}
          </span>
          <span aria-hidden>·</span>
          <span>append-only</span>
        </div>

        <div className="mt-5 flex flex-col gap-6 lg:flex-row lg:items-end lg:gap-10">
          {/* headline */}
          <div className="shrink-0">
            <div className="flex items-center gap-1.5 text-[length:var(--t-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--on-ink-faint)]">
              Net customer cost
              <span
                className="cursor-help text-[var(--on-ink-faint)]"
                title="Deposits + no-show charges, net of refunds — must land on ₹0 after a merchant decline."
                aria-label="Deposits plus no-show charges, net of refunds"
              >
                ⓘ
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-3">
              <span
                key={totals.netCustomerCostPaise}
                className="figure-in font-mono text-[length:var(--t-figure)] font-semibold leading-none tabular-nums tracking-[-0.02em] sm:text-[length:var(--t-figure-lg)]"
                style={{ color: zero ? 'var(--good-on-ink)' : 'var(--on-ink)' }}
              >
                {formatRupees(totals.netCustomerCostPaise)}
              </span>
              {zero && (
                <span
                  className="rounded-full px-2.5 py-1 text-[length:var(--t-xs)] font-semibold"
                  style={{ background: 'oklch(0.615 0.155 152 / 0.16)', color: 'var(--good-on-ink)' }}
                >
                  Fully unwound — nothing collected
                </span>
              )}
            </div>
          </div>

          {/* ruled row of supporting figures */}
          <div className="flex min-w-0 flex-1 flex-col divide-y divide-[var(--ink-line-soft)] sm:flex-row sm:divide-x sm:divide-y-0 lg:border-l lg:border-[var(--ink-line-soft)]">
            <Figure
              label="Merchant retention"
              value={formatRupees(totals.netMerchantRetentionPaise)}
              note={
                totals.sunkMdrPaise > 0 ? (
                  <>
                    kept from cancellations + no-shows ·{' '}
                    <span
                      className="font-mono font-semibold"
                      style={{ color: 'var(--warning-on-ink)' }}
                      title="Razorpay's platform fee is charged at capture and never reversed on a refund — docs/05-cost-model.md."
                    >
                      −{formatRupees(totals.sunkMdrPaise)} sunk MDR
                    </span>
                  </>
                ) : (
                  'kept from cancellations + no-shows'
                )
              }
            />
            <Figure
              label="Refusals"
              value={String(refusalCount)}
              tone={refusalCount > 0 ? 'critical' : 'default'}
              note={refusalCount > 0 ? 'bounds demonstrated, not just claimed' : '0 attempted breaches'}
              onClick={onFilterRefusals}
              title="Show only refused actions"
            />
            <Figure
              label="Authorisation headroom"
              value={formatRupees(totals.authorizationHeadroomPaise)}
              note="across every still-open authorisation"
            />
          </div>
        </div>
      </div>
    </section>
  )
}
