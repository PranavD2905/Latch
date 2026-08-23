#!/usr/bin/env node
/**
 * Slice 1 entrypoint: MCP over stdio, for local dev / connecting from
 * Claude Code or Claude Desktop directly. docs/02-tech-stack.md §3 — stdio
 * now, Streamable HTTP comes in Slice 7 and will reuse `createServer`
 * unchanged.
 *
 * Wires real Postgres adapters + a `FakePaymentProvider` (no Razorpay yet,
 * per Slice 1 scope) + the system clock.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { AppDeps } from '../../app/types.js'
import { SystemClock } from '../clock/system-clock.js'
import { createDbClient } from '../db/client.js'
import { PostgresCatalogRepo } from '../db/postgres-catalog-repo.js'
import { PostgresEventStore } from '../db/postgres-event-store.js'
import { PostgresIdempotencyStore } from '../db/postgres-idempotency-store.js'
import { SEED_MERCHANT_ID } from '../db/seed-data.js'
import { FakePaymentProvider } from '../payment/fake-payment-provider.js'
import { createServer } from './server.js'

process.loadEnvFile?.('.env')

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set')
}

const { db } = createDbClient(databaseUrl)

const deps: AppDeps = {
  clock: new SystemClock(),
  eventStore: new PostgresEventStore(db),
  catalogRepo: new PostgresCatalogRepo(db),
  paymentProvider: new FakePaymentProvider(),
  idempotencyStore: new PostgresIdempotencyStore(db),
  merchantId: process.env['MERCHANT_ID'] ?? SEED_MERCHANT_ID,
}

const server = createServer(deps)
const transport = new StdioServerTransport()
await server.connect(transport)
