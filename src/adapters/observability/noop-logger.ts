import type { Logger } from '../../ports/logger.js'

/**
 * The `Logger` counterpart to `FrozenClock` (`adapters/clock/frozen-clock.ts`)
 * — a real, minimal implementation swapped in for tests, rather than a mock
 * of the production one. Plain no-op functions rather than a real Pino
 * instance at `level: 'silent'`: this runs in every integration test file's
 * top-level `AppDeps`, and a real Pino instance (even silent) still spins up
 * a `pino-pretty` worker thread per call site under this repo's non-`NODE_ENV=
 * production` default — pure overhead across dozens of test files that never
 * read a single log line.
 */
export function createNoopLogger(): Logger {
  // `fatal`/`trace` aren't part of the `Logger` port (nothing in `src/app/`
  // needs them), but this same object gets threaded into `Fastify({
  // loggerInstance })` by test files that spin up a real merchant-api/MCP
  // server (`fastify-logging.ts`'s `loggingFastifyOptions`) — Fastify's own
  // `validateLogger` checks the actual object at boot, at runtime, for both
  // methods, independent of `Logger`'s narrower TypeScript shape. A real
  // Pino instance always has them; this is the one place the port and the
  // concrete object diverge.
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    trace: () => {},
    child: (): unknown => logger,
  }
  return logger as Logger
}
