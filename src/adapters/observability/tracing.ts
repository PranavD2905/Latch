import { trace, type Tracer } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { BatchSpanProcessor, ConsoleSpanExporter, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { loadEnv } from '../config.js'

/**
 * dev-logs/027. Deliberately **no auto-instrumentation** —
 * `@opentelemetry/instrumentation-http`/`-pg` and friends patch a target
 * module's `require`/`import` at load time (`require-in-the-middle`/
 * `import-in-the-middle` under the hood), which for a pure-ESM codebase
 * (`"type": "module"`, every file here) only works if the patching hook is
 * registered *before* Node starts evaluating the entry module at all — via
 * a `--import` flag on the `node`/`tsx` invocation itself, not by importing
 * a "tracing setup" module early in the entry file's own body the way
 * CommonJS allows. Wiring that correctly would mean changing how every one
 * of this project's ~10 npm scripts and Railway start commands launch the
 * process (docs/07-deployment.md), for auto-instrumentation of `postgres`
 * (this project's actual DB driver — there is no first-party OTel
 * instrumentation for it; `@opentelemetry/instrumentation-pg` targets the
 * unrelated `pg` package) and Fastify's underlying HTTP server. Shipping
 * that without being able to verify it actually patches under this exact
 * ESM/tsx/Node-22 combination would risk tracing that looks wired but
 * silently isn't — worse than not building it.
 *
 * Manual spans sidestep the whole problem: `NodeTracerProvider.register()`
 * below only registers a global tracer via a plain, synchronous JS API call
 * (`trace.setGlobalTracerProvider` under the hood) — no module patching, no
 * loader-hook requirement, works identically in ESM or CommonJS. Every span
 * this codebase creates is explicit — `mcp/server.ts`'s `withToolLogging`
 * (one per MCP tool call) and `observability/metrics.ts`'s
 * `instrumentRazorpayClient` (one per outbound Razorpay SDK call) — which
 * also means every span already has a real, meaningful name and attributes
 * attached on purpose, not a generic "GET /mcp" a blanket HTTP
 * instrumentation would have produced anyway.
 */
let provider: NodeTracerProvider | undefined

export function startTracing(service: string): void {
  const env = loadEnv()
  if (!env.OTEL_ENABLED || provider) return

  // Undefined `OTEL_EXPORTER_OTLP_ENDPOINT` -> spans print to the console —
  // deliberately the same "safe, visible local default" `observability/
  // logger.ts` uses for dev-mode logging.
  const exporter = env.OTEL_EXPORTER_OTLP_ENDPOINT ? new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT }) : new ConsoleSpanExporter()

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: service }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  })
  provider.register()
}

/**
 * `BatchSpanProcessor` buffers finished spans and only exports them
 * periodically (a few seconds by default) — a span created shortly before
 * the process exits is silently lost unless something flushes it first.
 * `setupGracefulShutdown` (`observability/graceful-shutdown.ts`) is exactly
 * the place that already exists for "flush/close a resource before exit"
 * (it does the same for the Postgres pool via `sql.end()`) — every
 * entrypoint that calls `startTracing` passes this to that same
 * `onShutdown` list. A no-op when tracing was never started.
 */
export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown()
}

/**
 * Safe to call unconditionally, even when `startTracing` was never called
 * (`OTEL_ENABLED` unset/false, the default) — the OpenTelemetry API is
 * designed exactly for this: `trace.getTracer(...)` returns a no-op tracer
 * when no provider is registered, so every span-creation call site in this
 * codebase can call this directly with no `if (env.OTEL_ENABLED)` guard of
 * its own.
 */
export function getTracer(): Tracer {
  return trace.getTracer('latch')
}
