-- Deposit becomes fully optional, same discipline the no-show fee already
-- has: a merchant may run with no upfront deposit at all, relying only on
-- the no-show and/or session-complete authorisation legs. See dev-logs
-- entry for the payment-link feature follow-up.

ALTER TABLE "policies" ALTER COLUMN "deposit_amount_paise" DROP NOT NULL;
