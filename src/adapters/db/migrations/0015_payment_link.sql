-- The payment-link feature: confirm_with_deposit can now return quickly with
-- pay links instead of blocking for up to five minutes with nothing for a
-- human to click. `pending_payment_legs` is what GET /pay/:bookingId/:leg
-- resolves a link's order/amount/label from — the URL itself carries only
-- bookingId and a leg name, never an authoritative amount. See dev-logs
-- entry for this slice.

ALTER TABLE "bookings" ADD COLUMN "pending_payment_legs" jsonb;

ALTER TYPE "event_type" ADD VALUE 'PAYMENT_REQUESTED';
