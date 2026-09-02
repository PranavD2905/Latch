import { TIER_COLOR } from './tierColors'
import type { BoundEnforcer } from './types'

const TIERS: { key: BoundEnforcer; label: string; sub: string }[] = [
  { key: 'latch_policy', label: 'Latch policy', sub: 'our own code' },
  { key: 'db_constraint', label: 'DB constraint', sub: 'postgres index' },
  { key: 'payment_rail', label: 'Payment rail', sub: 'Razorpay itself' },
]

/**
 * How many events each enforcement tier actually accounts for, ordered
 * weakest to strongest so the column reads as a ladder. Same three colours
 * as `EnforcedByBadge` — colour follows the entity, so the chart and the
 * per-event badge share one palette rather than each picking their own.
 * Bars, not a donut: three categories with a simple magnitude comparison is
 * exactly a bar chart's job.
 */
export function EnforcementBreakdown({ counts }: { counts: Record<BoundEnforcer, number> }) {
  const max = Math.max(1, ...Object.values(counts))
  const total = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <div>
      <div className="flex flex-col gap-3.5">
        {TIERS.map((tier, i) => {
          const value = counts[tier.key]
          const pct = (value / max) * 100
          return (
            <div key={tier.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex items-baseline gap-2">
                  <span className="flex gap-[2px] self-center" aria-hidden>
                    {[0, 1, 2].map((d) => (
                      <span
                        key={d}
                        className="h-[5px] w-[5px] rounded-full"
                        style={{ background: d <= i ? TIER_COLOR[tier.key] : 'var(--line-strong)' }}
                      />
                    ))}
                  </span>
                  <span className="text-[length:var(--t-sm)] font-medium text-[var(--text)]">{tier.label}</span>
                  <span className="text-[length:var(--t-2xs)] text-[var(--text-faint)]">{tier.sub}</span>
                </span>
                <span className="font-mono text-[length:var(--t-sm)] font-semibold tabular-nums text-[var(--text)]">{value}</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--paper-deep)]">
                <div
                  className="h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out-expo)]"
                  style={{ width: `${pct}%`, background: TIER_COLOR[tier.key] }}
                />
              </div>
            </div>
          )
        })}
      </div>

      <p className="mt-4 border-t border-[var(--line)] pt-3 text-[length:var(--t-xs)] leading-relaxed text-[var(--text-muted)]">
        {total === 0
          ? 'No bounded actions recorded yet — each one will land in the tier that actually enforced it.'
          : 'Each bounded action is attributed to the strongest thing that actually stopped it going further. Higher on this ladder means less of the guarantee rests on Latch being bug-free.'}
      </p>
    </div>
  )
}
