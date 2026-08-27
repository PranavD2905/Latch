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

export const MONEY_EVENT_TYPES = ['DEPOSIT_CAPTURED', 'RETENTION_APPLIED', 'REFUND_ISSUED', 'NO_SHOW_CHARGED', 'SESSION_COMPLETE_CHARGED'] as const

export function isMoneyEvent(event: BookingEvent): boolean {
  return (MONEY_EVENT_TYPES as readonly string[]).includes(event.type)
}

export function formatRupees(paise: number): string {
  const rupees = paise / 100
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: rupees % 1 === 0 ? 0 : 2 })}`
}

export function formatCompactRupees(paise: number): string {
  const rupees = paise / 100
  if (Math.abs(rupees) >= 100000) return `₹${(rupees / 100000).toFixed(1)}L`
  if (Math.abs(rupees) >= 1000) return `₹${(rupees / 1000).toFixed(1)}K`
  return formatRupees(paise)
}

/** Coarse grouping the pill-filter row switches between — mirrors a Payments-style status tab row. */
export type EventCategory = 'money' | 'refused' | 'lifecycle'

export function eventCategory(event: BookingEvent): EventCategory {
  if (event.type === 'ACTION_REFUSED') return 'refused'
  if (isMoneyEvent(event)) return 'money'
  return 'lifecycle'
}

/** A coarse, display-only status derived from the last significant event for a booking — not a re-implementation of `fold()`. */
export function bookingStatusLabel(events: readonly BookingEvent[]): { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral' | 'blue' } {
  const byType = new Map<string, BookingEvent>()
  for (const e of events) byType.set(e.type, e)

  if (byType.has('NO_SHOW_CHARGED')) return { label: 'No-show charged', tone: 'critical' }
  if (byType.has('SESSION_COMPLETE_CHARGED')) return { label: 'Completed', tone: 'good' }
  if (byType.has('BOOKING_COMPLETED')) return { label: 'Completed', tone: 'good' }
  if (byType.has('MERCHANT_DECLINED')) return { label: 'Declined by merchant', tone: 'critical' }
  if (byType.has('CANCELLED_BY_CUSTOMER')) return { label: 'Cancelled', tone: 'blue' }
  if (byType.has('NO_SHOW_ELIGIBLE')) return { label: 'No-show eligible', tone: 'warning' }
  if (byType.has('BOOKING_CONFIRMED')) return { label: 'Confirmed', tone: 'good' }
  if (byType.has('HOLD_EXPIRED')) return { label: 'Hold expired', tone: 'neutral' }
  if (byType.has('HOLD_RELEASED')) return { label: 'Released', tone: 'neutral' }
  if (byType.has('HOLD_CREATED')) return { label: 'Held', tone: 'warning' }
  return { label: 'Unknown', tone: 'neutral' }
}

export function shortId(id: string | undefined | null): string {
  if (!id) return '—'
  return id.length > 16 ? `${id.slice(0, 11)}…${id.slice(-4)}` : id
}
