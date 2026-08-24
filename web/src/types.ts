/**
 * Mirrors `src/domain/events.ts`'s `BookingEvent` union — hand-kept in sync
 * rather than shared via a package boundary (prompts/slice-6.md is explicit
 * that a build pipeline beyond Vite is out of scope). Dates arrive as ISO
 * strings, not `Date` objects — the SSE feed sends `JSON.stringify(event)`,
 * which serialises every `Date` field that way.
 */

export type MoneyDirection = 'credit' | 'debit'
export type Instrument = 'card' | 'upi' | 'netbanking' | 'wallet'
export type PaymentRail = 'manual_capture' | 'reserve_pay'
export type BoundEnforcer = 'latch_policy' | 'db_constraint' | 'payment_rail'

export interface MoneyAction {
  direction: MoneyDirection
  amountPaise: number
  instrument: Instrument
}

export interface GateCleared {
  cleared: readonly string[]
  evidence: Record<string, unknown>
}

export interface BoundApplied {
  ceilingPaise: number
  enforcedBy: BoundEnforcer
  headroomAfterPaise: number
}

export interface AuthorityRef {
  policyVersion: number
  authorizationId?: string
  razorpayPaymentId?: string
  razorpayRefundId?: string
}

export interface MoneyFields {
  action: MoneyAction
  gate: GateCleared
  bound: BoundApplied
  authority: AuthorityRef
}

export interface EventBase {
  eventId: string
  bookingId: string
  occurredAt: string
  sequence: number
}

/**
 * The full union isn't reproduced field-for-field for every non-money type —
 * the viewer only ever destructures fields it actually renders, and unknown
 * extra fields on a given event are harmless. `type` plus the four
 * `MoneyFields` (when present) is what the design actually depends on.
 */
export type BookingEvent = EventBase & {
  type: string
  [key: string]: unknown
} & Partial<MoneyFields>

export const MONEY_EVENT_TYPES = ['DEPOSIT_CAPTURED', 'RETENTION_APPLIED', 'REFUND_ISSUED', 'NO_SHOW_CHARGED'] as const

export function isMoneyEvent(event: BookingEvent): boolean {
  return (MONEY_EVENT_TYPES as readonly string[]).includes(event.type)
}

export function formatRupees(paise: number): string {
  const rupees = paise / 100
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: rupees % 1 === 0 ? 0 : 2 })}`
}
