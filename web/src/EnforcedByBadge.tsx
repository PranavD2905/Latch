import type { BoundEnforcer } from './types'

/**
 * The most important design decision in this UI: three genuinely different
 * strengths made visually inescapable. A filled-dot strength meter plus
 * escalating colour and border weight, not one grey badge with different
 * text — `payment_rail` has to read as unmistakably stronger at a glance,
 * even at video-compression quality on a phone.
 */
const CONFIG: Record<BoundEnforcer, { label: string; short: string; sub: string; className: string; dot: string; strength: number }> = {
  latch_policy: {
    label: 'LATCH POLICY',
    short: 'POLICY',
    sub: 'our own code — a bug could defeat it',
    className: 'bg-[var(--paper)] text-[var(--slate)] shadow-[inset_0_0_0_1px_var(--line-strong)]',
    dot: 'var(--tier-policy)',
    strength: 1,
  },
  db_constraint: {
    label: 'DB CONSTRAINT',
    short: 'DB',
    sub: 'postgres unique index — cannot be raced',
    className: 'bg-[var(--tier-db-bg)] text-[var(--tier-db-text)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--tier-db)_35%,transparent)]',
    dot: 'var(--tier-db)',
    strength: 2,
  },
  payment_rail: {
    label: 'PAYMENT RAIL',
    short: 'RAIL',
    sub: 'enforced by Razorpay — outside our trust boundary',
    className: 'bg-[var(--good-bg)] text-[var(--good-text)] shadow-[inset_0_0_0_2px_var(--good)]',
    dot: 'var(--tier-rail)',
    strength: 3,
  },
}

export function EnforcedByBadge({ enforcedBy, compact }: { enforcedBy: BoundEnforcer; compact?: boolean }) {
  const cfg = CONFIG[enforcedBy]
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-md px-2 py-1 ${cfg.className}`}
      title={`${cfg.label.toLowerCase()} — ${cfg.sub}`}
    >
      <span className="flex gap-[2px]" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            className="h-[5px] w-[5px] rounded-full"
            style={{ background: i <= cfg.strength ? cfg.dot : 'currentColor', opacity: i <= cfg.strength ? 1 : 0.18 }}
          />
        ))}
      </span>
      <span className="flex flex-col leading-[1.25]">
        <span className="font-mono text-[10px] font-bold tracking-[0.08em]">{compact ? cfg.short : cfg.label}</span>
        {!compact && <span className="font-mono text-[9px] opacity-75">{cfg.sub}</span>}
      </span>
    </span>
  )
}
