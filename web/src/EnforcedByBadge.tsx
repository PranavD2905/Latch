import type { BoundEnforcer } from './types'

/**
 * prompts/slice-6.md item 3 — "the most important design decision in the
 * UI." Three genuinely different strengths, made visually inescapable: a
 * filled-dot strength meter plus escalating color/weight/glow, not a single
 * grey badge with different text. `payment_rail` in particular must read as
 * unmistakably stronger at a glance, on a phone, at video-compression
 * quality — hence the heavy border and glow rather than a subtle hue shift.
 */
const CONFIG: Record<BoundEnforcer, { label: string; sub: string; className: string; strength: number }> = {
  latch_policy: {
    label: 'LATCH POLICY',
    sub: 'our own code — a bug could defeat it',
    className: 'border border-slate-600 bg-slate-800/50 text-slate-300',
    strength: 1,
  },
  db_constraint: {
    label: 'DB CONSTRAINT',
    sub: 'postgres unique index — cannot be raced',
    className: 'border border-sky-400 bg-sky-950/60 text-sky-200',
    strength: 2,
  },
  payment_rail: {
    label: 'PAYMENT RAIL',
    sub: 'enforced by Razorpay — outside our trust boundary',
    className:
      'border-2 border-emerald-400 bg-emerald-500/15 text-emerald-200 shadow-[0_0_0_1px_rgba(52,211,153,0.3),0_0_16px_rgba(52,211,153,0.45)]',
    strength: 3,
  },
}

export function EnforcedByBadge({ enforcedBy }: { enforcedBy: BoundEnforcer }) {
  const cfg = CONFIG[enforcedBy]
  return (
    <div className={`inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 ${cfg.className}`}>
      <span className="flex gap-0.5" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-2 w-2 rounded-full ${i <= cfg.strength ? 'bg-current' : 'bg-current/15'} ${
              cfg.strength === 3 ? 'animate-pulse' : ''
            }`}
          />
        ))}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-mono text-[11px] font-bold tracking-wider">{cfg.label}</span>
        <span className="font-mono text-[9px] opacity-75">{cfg.sub}</span>
      </span>
    </div>
  )
}
