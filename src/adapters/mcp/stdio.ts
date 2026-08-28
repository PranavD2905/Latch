#!/usr/bin/env node
/**
 * MCP over stdio, for local dev / connecting from Claude Code or Claude
 * Desktop directly. docs/02-tech-stack.md §3 — stdio now, Streamable HTTP
 * comes in Slice 7 and will reuse `createServer` unchanged.
 *
 * Wires real Postgres adapters + the system clock always. The payment
 * provider defaults to `FakePaymentProvider` and only switches to the real
 * `RazorpayPaymentProvider` when `PAYMENT_PROVIDER=razorpay` is explicitly
 * set — deliberately not just "whenever Razorpay keys are present in
 * .env", because `mcp-e2e.integration.test.ts` (Slice 1) spawns this exact
 * entrypoint as a subprocess and asserts `confirm_with_deposit` completes
 * synchronously. A real Razorpay capture only completes once a customer
 * finishes Checkout (see dev-logs/006) — nobody is present to do that
 * during an automated test run, so that test would hang and time out if
 * this defaulted to Razorpay whenever keys happen to be configured.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildAppDeps, requireDatabaseUrl } from '../build-deps.js'
import { createDbClient } from '../db/client.js'
import { loadEnvFile } from '../load-env.js'
import { createLogger } from '../observability/logger.js'
import { createServer } from './server.js'

loadEnvFile()

// Destination fd 2 (stderr), not the default fd 1 — stdout here **is** the
// MCP JSON-RPC transport (`StdioServerTransport` below), so a log line on
// fd 1 would corrupt the protocol stream. See `observability/logger.ts`'s
// own doc comment.
const logger = createLogger('latch-mcp-stdio', 2)
const { db } = createDbClient(requireDatabaseUrl())
const deps = buildAppDeps(db, logger)

const server = createServer(deps)
const transport = new StdioServerTransport()
await server.connect(transport)
