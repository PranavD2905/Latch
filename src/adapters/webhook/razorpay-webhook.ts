import type Razorpay from 'razorpay'
import { toPaise } from '../../domain/money.js'
import { reconcileObservedPayment } from '../../app/reconciliation.js'
import type { AppDeps } from '../../app/types.js'

/**
 * The subset of Razorpay's webhook body this adapter actually reads.
 * docs/01-architecture.md: no Razorpay SDK type crosses into `src/app/` or
 * `src/domain/` — this type lives here, in the adapter, and everything past
 * `handleRazorpayWebhookPayload` deals only in the app layer's own
 * `ObservedPayment` shape (`src/app/reconciliation.ts`).
 */
export interface RazorpayWebhookPayload {
  entity: string
  event: string
  payload: {
    payment?: { entity: { id: string; order_id: string | null; status: string; amount: number | string } }
  }
  created_at?: number
}

/**
 * dev-logs/014, item 2: deliberately narrow. `payment.captured` and
 * `payment.authorized` are the two events that can carry the actual gap-1
 * failure shape ("money moved at Razorpay, nothing in the trail") — every
 * other event this webhook might ever receive (`payment.failed`,
 * `refund.processed`, `order.paid`, ...) either moved no money or is already
 * Latch-initiated and synchronously recorded (a refund is always something
 * `decline_booking`/`cancel` itself appends `REFUND_ISSUED` for). Widening
 * this set is a one-line change if a real gap in that reasoning ever
 * surfaces; narrow-and-documented beats broad-and-unverified for a
 * security-adjacent surface.
 */
const RELEVANT_EVENTS = new Set(['payment.captured', 'payment.authorized'])

export interface WebhookHandleResult {
  /** False for an event this handler deliberately ignores (still a 200 — Razorpay must not see this as a delivery failure and retry forever). */
  handled: boolean
  bookingId?: string
  mismatch?: boolean
}

/**
 * Translates one already-signature-verified Razorpay webhook delivery into
 * the app layer's `reconcileObservedPayment` call. `bookingId` is resolved
 * by fetching the order the payment belongs to and reading
 * `order.notes.bookingId` — set at order-creation time by
 * `RazorpayPaymentProvider`/`ManualCaptureRail` (dev-logs/014) — rather than
 * trusting `payment.entity.notes`, which is not reliably a copy of the
 * order's notes on every Razorpay payment creation path.
 */
export async function handleRazorpayWebhookPayload(payload: RazorpayWebhookPayload, deps: AppDeps, razorpay: Razorpay): Promise<WebhookHandleResult> {
  if (!RELEVANT_EVENTS.has(payload.event)) {
    return { handled: false }
  }

  const entity = payload.payload.payment?.entity
  if (!entity?.order_id) {
    return { handled: false }
  }

  const bookingId = await resolveBookingId(entity.order_id, razorpay)
  if (!bookingId) {
    return { handled: false }
  }

  const status = entity.status === 'captured' ? 'captured' : entity.status === 'authorized' ? 'authorized' : undefined
  if (!status) {
    return { handled: false }
  }

  const { mismatch } = await reconcileObservedPayment(bookingId, { razorpayId: entity.id, orderId: entity.order_id, status, amountPaise: toPaise(Number(entity.amount)) }, deps)
  return { handled: true, bookingId, mismatch }
}

async function resolveBookingId(orderId: string, razorpay: Razorpay): Promise<string | undefined> {
  try {
    const order = await razorpay.orders.fetch(orderId)
    const notes = order.notes as Record<string, unknown> | undefined
    const bookingId = notes?.['bookingId']
    return typeof bookingId === 'string' ? bookingId : undefined
  } catch {
    // An order Razorpay can't resolve, or one that predates this slice (no
    // `notes.bookingId` set) — nothing to correlate against. Not an error:
    // the webhook is still acknowledged (see RELEVANT_EVENTS' comment on why
    // an ignored delivery must still 200).
    return undefined
  }
}
