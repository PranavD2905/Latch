#!/usr/bin/env tsx
/**
 * dev-logs/025. A throughput/latency baseline for `hold_slot` over MCP
 * Streamable HTTP — "how many holds succeeding vs failing, p99 latency" is
 * exactly what `latch_tool_duration_ms{tool="hold_slot"}` (dev-logs/018)
 * already answers from *inside* the system; this answers it from the
 * outside, under real concurrent load, the way an actual agent fleet would
 * hit it.
 *
 * `hold_slot` chosen deliberately, not arbitrarily: it's this system's
 * highest-frequency, zero-money tool (docs/01-architecture.md §3 — "all
 * risk is pushed into the cheap, reversible phase"), so it's the one an
 * agent fleet would realistically call at the highest rate, and it's safe
 * to hammer repeatedly without moving real money or needing a human at
 * Razorpay Checkout the way `confirm_with_deposit` would.
 *
 * Run against a server already started separately (`npm run mcp:http:dev`
 * or a deployed instance) — this script only sends load, it doesn't own the
 * server's lifecycle:
 *
 *   npm run load-test
 *   LOAD_TEST_URL=http://localhost:4000/mcp/mer_clinic npm run load-test
 *   LOAD_TEST_CONNECTIONS=50 LOAD_TEST_DURATION_SECONDS=30 npm run load-test
 *
 * **`MCP_RATE_LIMIT_MAX` will dominate the result before you learn anything
 * about `hold_slot` itself** unless you raise it. The transport-level DoS
 * throttle (dev-logs/017, `streamable-http-server.ts`) defaults to 300
 * requests/60s *per caller IP* — this script runs from one IP, so anything
 * above that rate mostly measures how fast the target rejects a flood, not
 * how fast `hold_slot` itself completes. Set `MCP_RATE_LIMIT_MAX` generously
 * high on the target server for a genuine handler-throughput run.
 */
import autocannon, { type Request } from 'autocannon'
import { ulid } from 'ulid'

const url = process.env['LOAD_TEST_URL'] ?? 'http://localhost:4000/mcp/mer_clinic'
const connections = Number(process.env['LOAD_TEST_CONNECTIONS'] ?? 10)
const durationSeconds = Number(process.env['LOAD_TEST_DURATION_SECONDS'] ?? 10)
const practitionerId = process.env['LOAD_TEST_PRACTITIONER_ID'] ?? 'prac_dr_rao'
const serviceId = process.env['LOAD_TEST_SERVICE_ID'] ?? 'svc_derm_consult'

/**
 * Every request uses a fresh, unique `agentId` — deliberately, not an
 * oversight. `hold_slot` enforces two per-agent bounds (`docs/01-
 * architecture.md` §12: `maxConcurrentHoldsPerAgent`, `holdRateLimitPerMinute`
 * — both real, DB-verified, and correctly *not* things this load test should
 * be measuring). Reusing one `agentId` across many concurrent requests would
 * mean most of them fail on `HOLD_LIMIT_REACHED`/`RATE_LIMITED` almost
 * immediately — a real, working bound doing exactly its job, but noise for a
 * "how fast does the handler complete" baseline, not signal.
 *
 * `startsAt` is spread across a wide future window at one-minute resolution
 * so concurrent requests essentially never collide on the same slot — this
 * measures `hold_slot`'s own throughput, not its (already separately tested
 * — `concurrency-slot.integration.test.ts`) `SLOT_TAKEN` collision path.
 */
const SLOT_WINDOW_START_MS = Date.now() + 365 * 24 * 60 * 60 * 1000
const SLOT_WINDOW_MINUTES = 500_000

function buildHoldSlotRequest(request: Request): Request {
  const startsAt = new Date(SLOT_WINDOW_START_MS + Math.floor(Math.random() * SLOT_WINDOW_MINUTES) * 60_000).toISOString()
  request.body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'hold_slot',
      arguments: {
        agentId: `loadtest_${ulid()}`,
        practitionerId,
        serviceId,
        startsAt,
        idempotencyKey: `loadtest_${ulid()}`,
      },
    },
  })
  return request
}

console.log(`load-testing hold_slot against ${url} — ${connections} connections, ${durationSeconds}s`)

const instance = autocannon(
  {
    url,
    connections,
    duration: durationSeconds,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    requests: [{ method: 'POST', setupRequest: buildHoldSlotRequest }],
  },
  (err, result) => {
    if (err) {
      console.error(err)
      process.exitCode = 1
      return
    }
    console.log(autocannon.printResult(result))
    // MCP tool errors/refusals (SLOT_TAKEN, RATE_LIMITED, ...) come back as
    // HTTP 200 with a JSON-RPC body — autocannon only sees transport-level
    // status codes, so a 100% "2xx" result here does not by itself mean
    // every hold actually succeeded. Cross-check against
    // latch_tool_invocations_total{tool="hold_slot",status="success"} on the
    // target server's own GET /metrics (dev-logs/018) for the real
    // success/refused/error breakdown.
    console.log('\nNote: HTTP status alone does not distinguish a successful hold_slot from a refused one (SLOT_TAKEN, RATE_LIMITED, ...) — both return HTTP 200.')
    console.log('Check GET /metrics on the target server for latch_tool_invocations_total{tool="hold_slot"} to see the real outcome breakdown.')
  },
)

autocannon.track(instance, { renderProgressBar: true })
