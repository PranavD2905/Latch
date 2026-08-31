/**
 * The refusal vocabulary. docs/03-domain-model.md §5. Every gate and bound
 * has one stable, machine-readable code — agents need this far more than
 * humans need prose.
 */
export const REFUSAL_CODES = [
  'SLOT_TAKEN',
  'HOLD_EXPIRED',
  'HOLD_LIMIT_REACHED',
  'POLICY_NOT_ACKNOWLEDGED',
  'POLICY_VERSION_STALE',
  'CAPTURE_AMOUNT_MISMATCH',
  'LADDER_FORBIDS_MOVE',
  'IDEMPOTENT_REPLAY',
  'RATE_LIMITED',
  /** The service's current price is less than the merchant's deposit amount — the session-complete mandate (price − deposit) would be negative. Structurally refused, same tier as CAPTURE_AMOUNT_MISMATCH: nothing an agent can do about it. */
  'SERVICE_PRICE_BELOW_DEPOSIT',
] as const

export type RefusalCode = (typeof REFUSAL_CODES)[number]

/**
 * Thrown by app-layer command handlers when a gate or bound rejects a
 * command. Handlers catch this, append an `ACTION_REFUSED` event (docs
 * §4 footnote ★★ — "refusals are events too"), and translate it into the
 * tool's refused result. Never thrown by the pure domain functions
 * themselves (ladder/slots) — those just compute; the handler decides
 * what the computed result means for a given command.
 */
export class Refusal extends Error {
  readonly code: RefusalCode

  constructor(code: RefusalCode, message: string) {
    super(message)
    this.name = 'Refusal'
    this.code = code
  }
}
