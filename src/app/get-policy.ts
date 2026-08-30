import type { Policy } from '../domain/policy.js'
import type { AppDeps } from './types.js'

export class NoActivePolicyError extends Error {}

export interface GetPolicyResult {
  policy: Policy
}

/**
 * `get_policy` — the versioned ladder, machine-readable, so an agent can
 * tell its user "cancel before Thursday 3pm or you're charged ₹400" without
 * a human explaining it. No gate, no money.
 */
export async function getPolicy(deps: AppDeps): Promise<GetPolicyResult> {
  const policy = await deps.catalogRepo.getActivePolicy(deps.merchantId)
  if (!policy) {
    throw new NoActivePolicyError(`no active policy for merchant ${deps.merchantId}`)
  }
  return { policy }
}
