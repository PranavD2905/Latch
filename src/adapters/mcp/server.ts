import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { SpanStatusCode } from '@opentelemetry/api'
import { z } from 'zod'
import { cancelBooking } from '../../app/cancel-booking.js'
import { chargeNoShow } from '../../app/charge-no-show.js'
import { confirmWithDeposit } from '../../app/confirm-with-deposit.js'
import { findSlots } from '../../app/find-slots.js'
import { getBooking } from '../../app/get-booking.js'
import { getPolicy } from '../../app/get-policy.js'
import { holdSlot } from '../../app/hold-slot.js'
import { rescheduleBooking } from '../../app/reschedule-booking.js'
import type { AppDeps } from '../../app/types.js'
import { Refusal } from '../../domain/refusals.js'
import { toolDurationMs, toolInvocationsTotal } from '../observability/metrics.js'
import { getTracer } from '../observability/tracing.js'

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/** Refusals are a normal, structured outcome — not a transport-level error — but flagged `isError` so a client can branch on it without parsing text. */
function refusalResult(refusal: Refusal): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ refused: true, code: refusal.code, reason: refusal.message }, null, 2) }],
  }
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }] }
}

/**
 * One wrapper around every tool handler below, instead of a repeated
 * try/catch in each: logs the invocation, records the Prometheus counter/
 * histogram pair (`observability/metrics.ts`), opens a span
 * (`observability/tracing.ts` — a no-op unless `OTEL_ENABLED`, safe to call
 * unconditionally), times it against `deps.clock` (this codebase's only
 * source of "now" — docs/01-architecture.md §5, and it means a test driving
 * a `FrozenClock` gets deterministic durations too), and turns the same
 * three outcomes `errorResult`/`refusalResult` already distinguish (success
 * / refused / error) into one structured log line + one metric observation
 * + one span status each. Any span `fn()` creates underneath this — a
 * Razorpay call, via `instrumentRazorpayClient` — becomes a *child* of this
 * span automatically, since `startActiveSpan` makes it the active context
 * for the duration of `fn`; that's a real, meaningful trace tree, not two
 * unrelated spans. `deps.logger` already carries `traceId` by the time it
 * reaches here — see `streamable-http-server.ts`'s `requestDeps`.
 */
async function withToolLogging<T>(deps: AppDeps, tool: string, args: unknown, fn: () => Promise<T>): Promise<CallToolResult> {
  return getTracer().startActiveSpan(tool, async (span) => {
    const startedAt = deps.clock.now().getTime()
    deps.logger.info({ tool, args }, 'tool invocation started')
    try {
      const result = await fn()
      const durationMs = deps.clock.now().getTime() - startedAt
      deps.logger.info({ tool, status: 'success', durationMs }, 'tool invocation completed')
      toolInvocationsTotal.inc({ tool, status: 'success', code: '' })
      toolDurationMs.observe({ tool, status: 'success' }, durationMs)
      span.setStatus({ code: SpanStatusCode.OK })
      return jsonResult(result)
    } catch (err) {
      const durationMs = deps.clock.now().getTime() - startedAt
      if (err instanceof Refusal) {
        deps.logger.info({ tool, status: 'refused', code: err.code, durationMs }, 'tool invocation refused')
        toolInvocationsTotal.inc({ tool, status: 'refused', code: err.code })
        toolDurationMs.observe({ tool, status: 'refused' }, durationMs)
        // A refusal is a normal, structured outcome (docs/03-domain-model.md
        // §5) — not a span-level error; the refusal code is still attached
        // as an attribute, so it's visible in a trace without the span
        // itself reading as a failure.
        span.setAttribute('latch.refusal_code', err.code)
        span.setStatus({ code: SpanStatusCode.OK })
        return refusalResult(err)
      }
      deps.logger.error({ tool, status: 'error', err, durationMs }, 'tool invocation failed')
      toolInvocationsTotal.inc({ tool, status: 'error', code: err instanceof Error ? err.name : 'UnknownError' })
      toolDurationMs.observe({ tool, status: 'error' }, durationMs)
      span.recordException(err instanceof Error ? err : new Error(String(err)))
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
      return errorResult(err)
    } finally {
      span.end()
    }
  })
}

/**
 * Builds the four Slice 1 tools (docs/06-build-sequence.md — Slice 1) over
 * `deps`. Kept separate from the stdio entrypoint (`stdio.ts`) so this is
 * testable without a real subprocess/transport, and so Slice 7's
 * Streamable HTTP transport can reuse it unchanged.
 */
export function createServer(deps: AppDeps): McpServer {
  const server = new McpServer({ name: 'latch', version: '0.1.0' })

  server.registerTool(
    'find_slots',
    {
      description:
        'Find available appointment slots for a practitioner and service. Computed live from the practitioner\'s working hours minus existing live bookings — there is no stored slot inventory, so results always reflect true availability.',
      inputSchema: {
        practitionerId: z.string().describe('Practitioner id, e.g. "prac_dr_rao"'),
        serviceId: z.string().describe('Service id, e.g. "svc_derm_consult"'),
        days: z.number().int().positive().max(60).optional().describe('How many days ahead to search. Default 14.'),
      },
    },
    async (args) => withToolLogging(deps, 'find_slots', args, () => findSlots(args, deps)),
  )

  server.registerTool(
    'get_policy',
    {
      description:
        "Read the merchant's current versioned policy: deposit amount, the cancellation ladder (retention percentage by hours-before-appointment), no-show fee, and hold TTL. Always call this before confirm_with_deposit and pass back the returned policyVersion as acknowledgedPolicyVersion.",
      inputSchema: {},
    },
    async () => withToolLogging(deps, 'get_policy', {}, () => getPolicy(deps)),
  )

  server.registerTool(
    'get_booking',
    {
      description:
        "Read-only status for one booking: its lifecycle status, deposit/authorisation state, and hold expiry if still held. No gate, no money moved. Always safe to call, including as a retry after a prior tool call timed out without a response — this reports what actually happened server-side rather than what the caller assumes happened. If confirm_with_deposit is waiting on a payment, the result's pendingPayment field lists what's still outstanding and what's already done, each with a plain-language label and amount (e.g. \"₹400 no-show hold — only charged if you miss your appointment\") — read these out in normal sentences, never as raw field names or leg identifiers. This tool alone never finishes a booking, even if everything shows as done — only confirm_with_deposit actually confirms it, so if pendingPayment.outstanding is empty here, call confirm_with_deposit next rather than telling the user it's confirmed.",
      inputSchema: {
        bookingId: z.string().describe('bookingId returned by hold_slot'),
      },
    },
    async (args) => withToolLogging(deps, 'get_booking', args, () => getBooking(args, deps)),
  )

  server.registerTool(
    'hold_slot',
    {
      description:
        'Place a temporary hold on a slot. Moves no money. The hold expires after holdExpiresAt (from policy) unless confirmed first. Idempotent: retry the same idempotencyKey safely after a timeout.',
      inputSchema: {
        agentId: z.string().describe('Stable id for the calling agent — used for the concurrent-hold limit.'),
        practitionerId: z.string(),
        serviceId: z.string(),
        startsAt: z.string().datetime().describe('Exact slot start time, as returned by find_slots (ISO 8601).'),
        idempotencyKey: z.string(),
      },
    },
    async (args) => withToolLogging(deps, 'hold_slot', args, () => holdSlot({ ...args, startsAt: new Date(args.startsAt) }, deps)),
  )

  server.registerTool(
    'confirm_with_deposit',
    {
      description:
        "Confirm a held booking. Depending on the merchant's policy this captures a deposit, registers a no-show authorisation, and/or registers a session-complete mandate for the rest of the price — only the legs the policy actually calls for; a merchant with no deposit configured has no deposit leg at all, for example. Requires a live, unexpired hold and the current policy version acknowledged — call get_policy first and pass its policyVersion as acknowledgedPolicyVersion. Since this account can't take payment server-to-server, a human has to actually pay, so this call returns FAST rather than waiting.\n\n" +
        "If status is 'PENDING': give the user the single payUrl verbatim as a link (one page covers every applicable leg, however many there are). Describe what it covers using each item in outstanding — its label already reads naturally, e.g. \"a ₹300 deposit for your booking\" and \"a ₹400 no-show hold, only charged if you miss your appointment\" — never mention field names like 'leg' or 'outstanding' or show raw JSON. Then STOP and ask the user to say once they've paid. Do not call this tool again on a timer, and do not retry it speculatively — only call it again after the user tells you they've paid, or explicitly asks you to check. When you do check again: use the SAME bookingId and idempotencyKey (cheap re-check, not a re-charge, safe to call repeatedly). If it's still PENDING, some items may now be missing from outstanding because they're done — tell the user in plain language exactly which ones are still left (e.g. \"the deposit went through, but the no-show hold hasn't been authorised yet\") and ask again; do not assume everything succeeded just because you're checking.\n\n" +
        "If status is 'CONFIRMED', every applicable leg landed and the booking is done — nothing more to do.\n\n" +
        "If the tool call itself times out or the connection drops, do NOT assume it failed and do NOT retry with a new idempotencyKey — call get_booking first to see what actually happened, and only retry confirm_with_deposit with the identical idempotencyKey if get_booking shows the booking is still HELD with something outstanding. The booking stays safely HELD for several minutes while all this plays out (never lost, never double-charged); if the human never pays, it eventually reverts to available inventory on its own.",
      inputSchema: {
        bookingId: z.string().describe('bookingId returned by hold_slot'),
        agentId: z.string(),
        acknowledgedPolicyVersion: z.number().int().optional().describe('The policyVersion from get_policy — required to confirm.'),
        idempotencyKey: z.string(),
      },
    },
    async (args) => withToolLogging(deps, 'confirm_with_deposit', args, () => confirmWithDeposit(args, deps)),
  )

  server.registerTool(
    'charge_no_show',
    {
      description:
        'Charge the no-show fee against the authorisation registered at booking. Gated on two independent facts: the appointment start time plus grace period must have elapsed (server clock — never an agent claim), and the merchant must have separately marked the booking as a no-show (an agent cannot do this). Captures the authorisation in full — the rail refuses any amount other than exactly what was authorised.',
      inputSchema: {
        bookingId: z.string().describe('bookingId returned by hold_slot'),
        idempotencyKey: z.string(),
      },
    },
    async (args) => withToolLogging(deps, 'charge_no_show', args, () => chargeNoShow(args, deps)),
  )

  server.registerTool(
    'cancel',
    {
      description:
        'Cancel a confirmed booking as the customer. The cancellation ladder applies: how much of the deposit is retained vs. refunded is computed from how far ahead of the appointment the cancellation happens, at the server clock — never a time the caller claims. Releases the no-show authorisation; leaves no live authority against the booking.',
      inputSchema: {
        bookingId: z.string().describe('bookingId returned by hold_slot'),
        idempotencyKey: z.string(),
      },
    },
    async (args) => withToolLogging(deps, 'cancel', args, () => cancelBooking(args, deps)),
  )

  server.registerTool(
    'reschedule',
    {
      description:
        'Move a confirmed booking to a new start time — the same booking, deposit, and no-show authorisation, not a cancel-and-rebook. Requires the target slot to be free and the cancellation ladder to permit a move at the current time-to-appointment, evaluated against the booking\'s existing start time; refused with LADDER_FORBIDS_MOVE if too close in (cancel instead, accepting the ladder), or SLOT_TAKEN if the target is already occupied.',
      inputSchema: {
        bookingId: z.string().describe('bookingId returned by hold_slot'),
        newStartsAt: z.string().datetime().describe('The new slot start time, as returned by find_slots (ISO 8601).'),
        idempotencyKey: z.string(),
      },
    },
    async (args) => withToolLogging(deps, 'reschedule', args, () => rescheduleBooking({ ...args, newStartsAt: new Date(args.newStartsAt) }, deps)),
  )

  return server
}
