import type { BoundEnforcer } from './types'

const TIERS: { key: BoundEnforcer; label: string; barClassName: string }[] = [
  { key: 'latch_policy', label: 'Latch policy', barClassName: 'bg-[var(--slate)]' },
  { key: 'db_constraint', label: 'DB constraint', barClassName: 'bg-[var(--blue)]' },
  { key: 'payment_rail', label: 'Payment rail', barClassName: 'bg-[var(--good)]' },
]

/**
 * How many events each enforcement tier actually accounts for — the
 * same three colors as `EnforcedByBadge` (color follows the entity: this
 * chart and the per-event badge encode the identical category, so they
 * share a palette rather than each picking their own). Bars, not a donut —
 * three categories with a simple magnitude comparison is exactly a bar
 * chart's job (dataviz skill, choosing-a-form).
 */
export function EnforcementBreakdown({ counts }: { counts: Record<BoundEnforcer, number> }) {
  const max = Math.max(1, ...Object.values(counts))
  return (
    <div className="space-y-3">
      {TIERS.map((tier) => {
        const value = counts[tier.key]
        const pct = (value / max) * 100
        return (
          <div key={tier.key} className="flex items-center gap-3">
            <span className="w-24 shrink-0 font-mono text-[11px] text-[var(--text-muted)]">{tier.label}</span>
            <div className="h-4 flex-1 rounded-sm bg-[var(--slate-bg)]">
              <div className={`h-4 rounded-sm ${tier.barClassName}`} style={{ width: `${Math.max(pct, value > 0 ? 3 : 0)}%` }} />
            </div>
            <span className="w-6 shrink-0 text-right font-mono text-[11px] font-semibold tabular-nums text-[var(--text)]">{value}</span>
          </div>
        )
      })}
    </div>
  )
}
