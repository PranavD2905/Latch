import type { AuthorizeParams, AuthorizeResult, CaptureAuthorizationParams, CaptureAuthorizationResult, PaymentRail } from '../../ports/payment-rail.js'

/**
 * The documented, unbuilt production rail (dev-logs/005/007). UPI Reserve
 * Pay is a real, named Razorpay/NPCI product — a customer pre-approves a
 * spending limit once, with "no repeated approvals" needed after — but it is
 * activation-gated (a support request plus an eligible business category)
 * and has no documented test-mode flow, so it cannot be built against in
 * this buildathon (dev-logs/005, dev-logs/007's survey of every
 * authorise-once-spend-later primitive in India: all are gated the same
 * way).
 *
 * This class exists to prove the swap from `ManualCaptureRail` is a module
 * boundary, not a rewrite: `src/app/` and `src/domain/` depend only on the
 * `PaymentRail` port, so activating Reserve Pay on the merchant's account is
 * a one-line change to which class `stdio.ts`/`http.ts` construct — nothing
 * in the domain or app layer would need to change. Both methods throw
 * because there is nothing to call; that is the honest state of this rail
 * today, not a placeholder for a rainy day.
 */
export class ReservePayRail implements PaymentRail {
  readonly name = 'reserve_pay' as const

  async authorize(_params: AuthorizeParams): Promise<AuthorizeResult> {
    throw new Error(
      'ReservePayRail is not built — UPI Reserve Pay is activation-gated with no documented test-mode flow (dev-logs/005/007). ' +
        'This class exists to prove the PaymentRail port is a real module boundary; it is not wired into any entrypoint.',
    )
  }

  async captureAuthorization(_params: CaptureAuthorizationParams): Promise<CaptureAuthorizationResult> {
    throw new Error('ReservePayRail is not built — see authorize() for why.')
  }
}
