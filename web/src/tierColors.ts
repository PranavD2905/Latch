import type { BoundEnforcer } from './types'

/**
 * One palette for the enforcement tiers, shared by the per-event badge and
 * the breakdown chart — colour follows the entity, so the two surfaces can
 * never drift apart. Kept out of the component files so importing it doesn't
 * cost either of them fast refresh.
 */
export const TIER_COLOR: Record<BoundEnforcer, string> = {
  latch_policy: 'var(--tier-policy)',
  db_constraint: 'var(--tier-db)',
  payment_rail: 'var(--tier-rail)',
}
