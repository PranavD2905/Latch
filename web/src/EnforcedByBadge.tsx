import type { BoundEnforcer } from './types'

/**
 * The most important pill on the screen: three genuinely different strengths,
 * made visually inescapable rather than described in text. The filled-dot
 * meter is the icon slot — escalating fill, escalating colour — so
 * `payment_rail` reads as stronger than `latch_policy` at a glance, even at
 * video-compression quality.
 */
const CONFIG: Record<BoundEnforcer, { label: string; short: string; sub: string; bg: string; text: string; dot: string; strength: number }> = {
  latch_policy: {
    label: 'Latch policy',
    short: 'Policy',
    sub: 'our own code — a bug could defeat it',
    bg: 'var(--tier-policy-bg)',
    text: 'var(--tier-policy-text)',
    dot: 'var(--tier-policy)',
    strength: 1,
  },
  db_constraint: {
    label: 'DB constraint',
    short: 'DB',
    sub: 'postgres unique index — cannot be raced',
    bg: 'var(--tier-db-bg)',
    text: 'var(--tier-db-text)',
    dot: 'var(--tier-db)',
    strength: 2,
  },
  payment_rail: {
    label: 'Payment rail',
    short: 'Rail',
    sub: 'enforced by Razorpay — outside our trust boundary',
    bg: 'var(--tier-rail-bg)',
    text: 'var(--tier-rail-text)',
    dot: 'var(--tier-rail)',
    strength: 3,
  },
}

export function StrengthMeter({ strength, color }: { strength: number; color: string }) {
  return (
    <span className="flex gap-[2px]" aria-hidden>
      {[1, 2, 3].map((i) => (
        <span key={i} className="h-[5px] w-[5px] rounded-full" style={{ background: color, opacity: i <= strength ? 1 : 0.22 }} />
      ))}
    </span>
  )
}

export function EnforcedByBadge({ enforcedBy, compact }: { enforcedBy: BoundEnforcer; compact?: boolean }) {
  const cfg = CONFIG[enforcedBy]
  return (
    <span className="pill" style={{ background: cfg.bg, color: cfg.text }} title={`${cfg.label} — ${cfg.sub}`}>
      <StrengthMeter strength={cfg.strength} color={cfg.dot} />
      {compact ? cfg.short : cfg.label}
    </span>
  )
}

export function enforcerLabel(enforcedBy: BoundEnforcer): string {
  return CONFIG[enforcedBy].label
}
