import type { BoundEnforcer } from './types'

/**
 * prompts/slice-6.md item 3 — "the most important design decision in the
 * UI." Three genuinely different strengths, made visually inescapable: a
 * filled-dot strength meter plus escalating color/weight, not a single grey
 * badge with different text. `payment_rail` reads as unmistakably stronger
 * at a glance — heavier border, saturated fill, filled meter — even at
 * video-compression quality on a phone.
 */
const CONFIG: Record<BoundEnforcer, { label: string; sub: string; className: string; dotClassName: string; strength: number }> = {
  latch_policy: {
    label: 'LATCH POLICY',
    sub: 'our own code — a bug could defeat it',
    className: 'border border-[var(--border-strong)] bg-white text-[var(--slate)]',
    dotClassName: 'bg-[var(--slate)]',
    strength: 1,
  },
  db_constraint: {
    label: 'DB CONSTRAINT',
    sub: 'postgres unique index — cannot be raced',
    className: 'border border-[var(--blue)]/40 bg-[var(--blue-bg)] text-[var(--blue-text)]',
    dotClassName: 'bg-[var(--blue)]',
    strength: 2,
  },
  payment_rail: {
    label: 'PAYMENT RAIL',
    sub: 'enforced by Razorpay — outside our trust boundary',
    className: 'border-2 border-[var(--good)] bg-[var(--good-bg)] text-[var(--good-text)]',
    dotClassName: 'bg-[var(--good)]',
    strength: 3,
  },
}

export function EnforcedByBadge({ enforcedBy, compact }: { enforcedBy: BoundEnforcer; compact?: boolean }) {
  const cfg = CONFIG[enforcedBy]
  return (
    <div className={`inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 ${cfg.className}`}>
      <span className="flex gap-0.5" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span key={i} className={`h-1.5 w-1.5 rounded-full ${i <= cfg.strength ? cfg.dotClassName : 'bg-black/10'}`} />
        ))}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-mono text-[10.5px] font-bold tracking-wider">{cfg.label}</span>
        {!compact && <span className="font-mono text-[9px] opacity-75">{cfg.sub}</span>}
      </span>
    </div>
  )
}
