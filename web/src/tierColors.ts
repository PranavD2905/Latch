import type { BoundEnforcer } from './types'

/**
 * One palette for the enforcement tiers, shared by the per-event pill and the
 * breakdown chart — colour follows the entity, so the two can never drift
 * apart. Kept in its own module so importing it costs neither component fast
 * refresh.
 */
export const TIER_COLOR: Record<BoundEnforcer, string> = {
  latch_policy: 'var(--tier-policy)',
  db_constraint: 'var(--tier-db)',
  payment_rail: 'var(--tier-rail)',
}
