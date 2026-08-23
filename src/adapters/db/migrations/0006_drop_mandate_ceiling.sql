-- dev-log 001's mandate-ceiling design was superseded by card manual capture
-- before it was ever exercised for real (dev-logs/005). Slice 4 confirms
-- nothing reads this column any more — the real ceiling is the authorised
-- amount itself (Policy.noShowFeePaise at authorize time,
-- BookingSnapshot.authorizationAmountPaise at charge time).
ALTER TABLE "policies" DROP COLUMN "mandate_ceiling_paise";
