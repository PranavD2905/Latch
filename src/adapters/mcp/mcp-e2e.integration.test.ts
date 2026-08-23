import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { eq } from 'drizzle-orm'
import { fileURLToPath } from 'node:url'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbClient } from '../db/client.js'
import { bookings, events } from '../db/schema.js'
import { SEED_PRACTITIONER_ID, SEED_SERVICE_ID } from '../db/seed-data.js'

/**
 * This is the "Done when" acceptance test from prompts/slice-1.md, taken
 * literally: "a real agent, over MCP, completes find_slots -> get_policy ->
 * hold_slot -> confirm_with_deposit." It spawns the actual `stdio.ts`
 * entrypoint as a subprocess (`tsx`, over real stdin/stdout) and drives it
 * with the same `@modelcontextprotocol/sdk` Client class a real agent would
 * use — nothing here calls the app-layer handlers directly.
 */

process.loadEnvFile?.('.env')
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://latch:latch@localhost:5432/latch'
const { sql, db } = createDbClient(databaseUrl)

const stdioEntry = fileURLToPath(new URL('./stdio.ts', import.meta.url))

let client: Client
let transport: StdioClientTransport
const createdBookingIds: string[] = []

function textOf(result: Awaited<ReturnType<Client['callTool']>>): any {
  if (!('content' in result) || !Array.isArray(result.content)) {
    throw new Error(`expected a content array (not a task result): ${JSON.stringify(result)}`)
  }
  const first = result.content[0] as { type?: string; text?: string } | undefined
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`expected text content, got: ${JSON.stringify(result)}`)
  }
  return JSON.parse(first.text)
}

function isError(result: Awaited<ReturnType<Client['callTool']>>): boolean {
  return 'isError' in result && result.isError === true
}

beforeAll(async () => {
  transport = new StdioClientTransport({ command: 'npx', args: ['tsx', stdioEntry] })
  client = new Client({ name: 'latch-e2e-test', version: '0.1.0' })
  await client.connect(transport)
}, 30_000)

afterAll(async () => {
  await client.close()
  for (const bookingId of createdBookingIds) {
    await db.delete(events).where(eq(events.bookingId, bookingId))
    await db.delete(bookings).where(eq(bookings.bookingId, bookingId))
  }
  await sql.end()
})

describe('MCP end-to-end over stdio — a real agent, over the real transport', () => {
  it('advertises the Slice 1 + Slice 4 tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['charge_no_show', 'confirm_with_deposit', 'find_slots', 'get_policy', 'hold_slot'])
  })

  it('completes find_slots -> get_policy -> hold_slot -> confirm_with_deposit', async () => {
    const found = textOf(
      await client.callTool({ name: 'find_slots', arguments: { practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, days: 30 } }),
    )
    expect(Array.isArray(found.slots)).toBe(true)
    expect(found.slots.length).toBeGreaterThan(0)
    const startsAt: string = found.slots[0]

    const policyResult = textOf(await client.callTool({ name: 'get_policy', arguments: {} }))
    expect(policyResult.policy.policyVersion).toBeGreaterThan(0)

    const agentId = `agent_e2e_${ulid()}`
    const held = textOf(
      await client.callTool({
        name: 'hold_slot',
        arguments: { agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: `e2e_${ulid()}` },
      }),
    )
    createdBookingIds.push(held.bookingId)
    expect(held.status).toBe('HELD')

    const confirmResultRaw = await client.callTool({
      name: 'confirm_with_deposit',
      arguments: {
        bookingId: held.bookingId,
        agentId,
        acknowledgedPolicyVersion: policyResult.policy.policyVersion,
        idempotencyKey: `e2e_${ulid()}`,
      },
    })
    expect(isError(confirmResultRaw)).toBe(false)
    const confirmed = textOf(confirmResultRaw)
    expect(confirmed.status).toBe('CONFIRMED')
    expect(confirmed.deposit.amountPaise).toBe(policyResult.policy.depositAmountPaise)
  }, 20_000)

  it('surfaces a refused confirm_with_deposit as an MCP tool error carrying a stable refusal code', async () => {
    const found = textOf(
      await client.callTool({ name: 'find_slots', arguments: { practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, days: 30 } }),
    )
    const startsAt: string = found.slots.at(-1) // a different, still-free slot from the previous test

    const agentId = `agent_e2e_${ulid()}`
    const held = textOf(
      await client.callTool({
        name: 'hold_slot',
        arguments: { agentId, practitionerId: SEED_PRACTITIONER_ID, serviceId: SEED_SERVICE_ID, startsAt, idempotencyKey: `e2e_${ulid()}` },
      }),
    )
    createdBookingIds.push(held.bookingId)

    // No acknowledgedPolicyVersion — must be refused, not silently accepted.
    const result = await client.callTool({
      name: 'confirm_with_deposit',
      arguments: { bookingId: held.bookingId, agentId, idempotencyKey: `e2e_${ulid()}` },
    })
    expect(isError(result)).toBe(true)
    const body = textOf(result)
    expect(body.refused).toBe(true)
    expect(body.code).toBe('POLICY_NOT_ACKNOWLEDGED')
  }, 20_000)
})
