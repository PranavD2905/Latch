import { toPaise } from '../domain/money.js'
import type { Policy, PolicyDraft, PolicyInput } from '../domain/policy.js'
import { validatePolicyInput } from '../domain/policy-validation.js'
import type { AppDeps } from './types.js'

/**
 * What a merchant submits to publish a new policy version. Deliberately has
 * no `version`/`policyVersion` field at all — not optional, not ignored,
 * *absent* — so "the server derives the version, never the client" is a
 * structural fact about this type, the same way `ChargeNoShowCommand` has no
 * `amountPaise` field (docs/01-architecture.md §9's trust-boundary test
 * pattern).
 */
export type SetPolicyCommand = PolicyDraft

export interface SetPolicyResult {
  policy: Policy
}

/**
 * `set_policy` — merchant-only (never registered as an MCP tool, only
 * reachable via the merchant API's bearer-token-gated route, same trust
 * boundary as `decline_booking`/`mark_no_show`). Publishing is an INSERT,
 * never an UPDATE: the previous version's row is untouched, forever, because
 * every past money event's `authority.policyVersion` cites it
 * (docs/03-domain-model.md §2). This is the whole reason the feature exists —
 * a booking confirmed under v4 must go on cancelling under v4 even after
 * this call publishes v5.
 *
 * Validation runs to completion before any write — a rejected command
 * changes nothing, never a partial policy.
 */
export async function setPolicy(cmd: SetPolicyCommand, deps: AppDeps): Promise<SetPolicyResult> {
  // Validates the raw, unbranded numbers: validatePolicyInput's error codes
  // (e.g. AMOUNT_NOT_POSITIVE_INTEGER) are what a merchant actually sees, and
  // it must run to completion — including range checks toPaise itself
  // doesn't perform — before anything is written.
  validatePolicyInput(cmd)

  // Only brand as Paise once validation has already proven both amounts are
  // non-negative integers — toPaise never throws here in practice.
  const input: PolicyInput = {
    ...cmd,
    depositAmountPaise: cmd.depositAmountPaise === undefined ? undefined : toPaise(cmd.depositAmountPaise),
    noShowFeePaise: cmd.noShowFeePaise === undefined ? undefined : toPaise(cmd.noShowFeePaise),
  }

  const policy = await deps.catalogRepo.publishPolicy(deps.merchantId, input, deps.clock.now())
  return { policy }
}
