-- Slice 4 follow-up: charge_no_show must capture exactly the amount that was
-- authorised at booking time, never the merchant's *current* policy figure
-- (docs/03-domain-model.md §2 — money rules don't change retroactively).
ALTER TABLE "bookings" ADD COLUMN "authorization_amount_paise" integer;
