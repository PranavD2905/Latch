import { SpanStatusCode } from '@opentelemetry/api'
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client'
import type { FastifyInstance } from 'fastify'
import { getTracer } from './tracing.js'

/**
 * One process-wide registry, matching this codebase's "one X per process"
 * instinct for cross-cutting infra (`circuit-breaker.ts`). `mcp/http.ts`
 * runs the MCP tool server *and* every background worker in one process
 * (its own module doc comment), so this one registry — and the `GET
 * /metrics` route mounted on it — already covers both without anything
 * extra: a tool-invocation metric and a background-worker's Razorpay-call
 * metric land in the same scrape.
 */
export const registry = new Registry()
collectDefaultMetrics({ register: registry })

/**
 * One counter/histogram pair, labeled by `tool`, rather than a separate
 * `latch_hold_slot_total`/`latch_confirm_with_deposit_total`/... per tool —
 * the eight MCP tools are structurally identical events (an invocation that
 * succeeds, is refused, or errors), and Prometheus's own guidance is to
 * spend a label dimension on that rather than multiply near-duplicate metric
 * names. `code` carries the `RefusalCode` for a refusal, or the thrown
 * error's constructor name for a genuine error — both are small, statically
 * defined sets in this codebase (`domain/refusals.ts`'s `RefusalCode` union;
 * the handful of `*Error` classes each app-layer file exports), so neither
 * risks unbounded cardinality the way an agentId/merchantId label would
 * (the same bound this file's `mcpRateLimitTriggeredTotal` below is
 * deliberately kept free of).
 */
export const toolInvocationsTotal = new Counter({
  name: 'latch_tool_invocations_total',
  help: 'MCP tool invocations, by tool and outcome.',
  labelNames: ['tool', 'status', 'code'] as const,
  registers: [registry],
})

export const toolDurationMs = new Histogram({
  name: 'latch_tool_duration_ms',
  help: 'MCP tool invocation duration in milliseconds, by tool and outcome.',
  labelNames: ['tool', 'status'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000],
  registers: [registry],
})

/**
 * Transport-level DoS rejections (`streamable-http-server.ts`'s own
 * `@fastify/rate-limit` config) — distinct from `latch_tool_invocations_total
 * {code="RATE_LIMITED"}`, which is the *business* rate ceiling
 * (`policy.holdRateLimitPerMinute`) firing inside a completed tool call. This
 * one fires before a request ever reaches a tool handler, so it needs its
 * own counter rather than reusing that label.
 */
export const mcpRateLimitTriggeredTotal = new Counter({
  name: 'latch_mcp_rate_limit_triggered_total',
  help: 'Transport-level MCP rate-limit rejections (429s), independent of the business-level RATE_LIMITED refusal.',
  registers: [registry],
})

/**
 * `method` is `${resource}.${sdkMethod}` (e.g. `orders.create`,
 * `payments.capture`) — see `instrumentRazorpayClient` below, which is what
 * actually populates these without touching each of the ~14 individual
 * `this.client.orders.create(...)`-style call sites across
 * `razorpay-payment-provider.ts`/`manual-capture-rail.ts`. One histogram
 * covers what the spec asked for as a separate `latch_razorpay_capture_
 * duration_ms` too — `{method="payments.capture"}` is that same series,
 * selected by label instead of by metric name.
 */
export const razorpayApiCallsTotal = new Counter({
  name: 'latch_razorpay_api_calls_total',
  help: 'Outbound Razorpay API calls, by SDK method and outcome.',
  labelNames: ['method', 'status'] as const,
  registers: [registry],
})

export const razorpayApiCallDurationMs = new Histogram({
  name: 'latch_razorpay_api_call_duration_ms',
  help: 'Outbound Razorpay API call duration in milliseconds, by SDK method.',
  labelNames: ['method'] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000],
  registers: [registry],
})

/**
 * Wraps a `Razorpay` client instance in a Proxy that times, counts, and
 * traces every `client.<resource>.<method>(...)` call transparently —
 * applied once at construction (`new Razorpay(...)`), not at each call
 * site. The alternative (hand-instrumenting every `orders.create`/
 * `orders.all`/`payments.fetch`/`payments.capture`/... call individually
 * across the two real adapters) is the same information for roughly 5x the
 * diff and a much easier place to miss one on the next SDK call this
 * codebase adds. Transparent: the wrapped client behaves identically to the
 * caller, including rethrowing the original error unchanged — this only
 * ever adds side-effecting telemetry, never changes control flow.
 *
 * `getTracer().startActiveSpan` (dev-logs/027) is what makes a call made
 * from inside an MCP tool handler show up as a *child* span of that tool's
 * own span (`mcp/server.ts`'s `withToolLogging`) — `startActiveSpan` picks
 * up whatever span is already active in the current async context, so
 * `confirm_with_deposit`'s trace ends up genuinely showing "captureDeposit
 * called payments.capture," not two disconnected spans a reader has to
 * correlate by hand.
 */
export function instrumentRazorpayClient<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, resourceKey, receiver) {
      const resource: unknown = Reflect.get(target, resourceKey, receiver)
      if (typeof resource !== 'object' || resource === null) return resource
      return new Proxy(resource, {
        get(resourceTarget, methodKey, resourceReceiver) {
          const method: unknown = Reflect.get(resourceTarget, methodKey, resourceReceiver)
          if (typeof method !== 'function') return method
          return async function instrumented(...args: unknown[]): Promise<unknown> {
            const label = `${String(resourceKey)}.${String(methodKey)}`
            return getTracer().startActiveSpan(`razorpay.${label}`, async (span) => {
              const stopTimer = razorpayApiCallDurationMs.startTimer({ method: label })
              try {
                const result: unknown = await Reflect.apply(method, resourceTarget, args)
                razorpayApiCallsTotal.inc({ method: label, status: 'success' })
                span.setStatus({ code: SpanStatusCode.OK })
                return result
              } catch (err) {
                razorpayApiCallsTotal.inc({ method: label, status: 'error' })
                span.recordException(err instanceof Error ? err : new Error(String(err)))
                span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
                throw err
              } finally {
                stopTimer()
                span.end()
              }
            })
          }
        },
      })
    },
  })
}

/** Mounted on every Fastify server that runs in a scrapeable process — see each server file's own call site. Unauthenticated, same posture as `/healthz` (docs/07-deployment.md: Railway's own health check needs it unauthenticated) and a deliberate, named trade-off, not an oversight: this repo has no scrape-auth mechanism designed yet, and nothing exposed here is per-merchant PII, only aggregate call/duration counts. */
export function registerMetricsRoute(app: FastifyInstance): void {
  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', registry.contentType)
    return await registry.metrics()
  })
}
