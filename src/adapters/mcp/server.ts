import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { cancelBooking } from '../../app/cancel-booking.js'
import { chargeNoShow } from '../../app/charge-no-show.js'
import { confirmWithDeposit } from '../../app/confirm-with-deposit.js'
import { findSlots } from '../../app/find-slots.js'
import { getPolicy } from '../../app/get-policy.js'
import { holdSlot } from '../../app/hold-slot.js'
import { rescheduleBooking } from '../../app/reschedule-booking.js'
import type { AppDeps } from '../../app/types.js'
import { Refusal } from '../../domain/refusals.js'

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
    async (args) => {
      try {
        return jsonResult(await findSlots(args, deps))
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  server.registerTool(
    'get_policy',
    {
      description:
        "Read the merchant's current versioned policy: deposit amount, the cancellation ladder (retention percentage by hours-before-appointment), no-show fee, and hold TTL. Always call this before confirm_with_deposit and pass back the returned policyVersion as acknowledgedPolicyVersion.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await getPolicy(deps))
      } catch (err) {
        return errorResult(err)
      }
    },
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
    async (args) => {
      try {
        return jsonResult(await holdSlot({ ...args, startsAt: new Date(args.startsAt) }, deps))
      } catch (err) {
        if (err instanceof Refusal) return refusalResult(err)
        return errorResult(err)
      }
    },
  )

  server.registerTool(
    'confirm_with_deposit',
    {
      description:
        'Confirm a held booking: captures the deposit immediately and separately registers a no-show authorisation for exactly the no-show fee (card manual capture, left uncaptured). Requires a live, unexpired hold and the current policy version acknowledged — call get_policy first and pass its policyVersion as acknowledgedPolicyVersion.',
      inputSchema: {
        bookingId: z.string().describe('bookingId returned by hold_slot'),
        agentId: z.string(),
        acknowledgedPolicyVersion: z.number().int().optional().describe('The policyVersion from get_policy — required to confirm.'),
        idempotencyKey: z.string(),
      },
    },
    async (args) => {
      try {
        return jsonResult(await confirmWithDeposit(args, deps))
      } catch (err) {
        if (err instanceof Refusal) return refusalResult(err)
        return errorResult(err)
      }
    },
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
    async (args) => {
      try {
        return jsonResult(await chargeNoShow(args, deps))
      } catch (err) {
        if (err instanceof Refusal) return refusalResult(err)
        return errorResult(err)
      }
    },
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
    async (args) => {
      try {
        return jsonResult(await cancelBooking(args, deps))
      } catch (err) {
        if (err instanceof Refusal) return refusalResult(err)
        return errorResult(err)
      }
    },
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
    async (args) => {
      try {
        return jsonResult(await rescheduleBooking({ ...args, newStartsAt: new Date(args.newStartsAt) }, deps))
      } catch (err) {
        if (err instanceof Refusal) return refusalResult(err)
        return errorResult(err)
      }
    },
  )

  return server
}
