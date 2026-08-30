import type { FastifyInstance } from 'fastify'
import type { Logger } from '../../ports/logger.js'

export interface GracefulShutdownOptions {
  /**
   * Closed first, if given — `FastifyInstance.close()` stops accepting new
   * connections and waits for in-flight ones to finish naturally (including
   * a hijacked one, e.g. the audit-trail SSE feed — Fastify's own reply
   * machinery isn't tracking it once hijacked, but the underlying HTTP
   * connection still is). That wait is unbounded on its own, which is
   * exactly why this whole module exists: `timeoutMs` below is the backstop.
   */
  app?: FastifyInstance
  /**
   * Run after `app` has closed (or immediately, if there's no `app`), in the
   * order given — e.g. `clearInterval` on a background tick so a fresh
   * iteration doesn't start mid-shutdown, then `sql.end()` on the Postgres
   * pool so connections close cleanly instead of being dropped by the OS
   * when the process exits.
   */
  onShutdown?: Array<() => Promise<void> | void>
  /** How long to wait for `app.close()` before giving up and forcing exit(1) anyway. Default 10s. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * dev-logs/022. Nothing in this codebase currently listens for SIGTERM —
 * Railway (and any other host) sends it on every deploy/restart, and today
 * every one of the five long-running entrypoints (`mcp/http.ts`,
 * `merchant-api/http.ts`, `audit-trail/http.ts`, `rest/http.ts`, the three
 * `worker/*.ts` standalone processes) dies immediately: in-flight HTTP
 * responses get dropped mid-request, a background tick mid-Razorpay-call is
 * cut off instead of finishing, and the raw `postgres` connection pool is
 * never closed cleanly. This is not catastrophic on its own — every
 * money-moving command is already idempotency-key-safe to retry
 * (docs/01-architecture.md §6), which is exactly the case this forces more
 * often than it needs to — but a routine deploy shouldn't be indistinguishable
 * from a crash.
 *
 * A second SIGTERM/SIGINT during an in-progress shutdown is a no-op, not a
 * second shutdown race — Railway (and `docker stop`) can send more than one
 * if a deploy is slow, and running the whole sequence twice concurrently
 * would double-close things that don't tolerate it (`sql.end()` twice, an
 * already-closing Fastify instance).
 */
export function setupGracefulShutdown(logger: Logger, options?: GracefulShutdownOptions): void {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let shuttingDown = false

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal, timeoutMs }, 'shutdown signal received, draining in-flight work')

    // `unref()`: this timer must never be the reason the process stays
    // alive past a clean exit — it only matters if shutdown is still
    // running when it fires.
    const forceExitTimer = setTimeout(() => {
      logger.error({ signal, timeoutMs }, 'graceful shutdown timed out — forcing exit')
      process.exit(1)
    }, timeoutMs)
    forceExitTimer.unref()

    try {
      if (options?.app) {
        await options.app.close()
      }
      for (const fn of options?.onShutdown ?? []) {
        await fn()
      }
      clearTimeout(forceExitTimer)
      logger.info({ signal }, 'shutdown complete')
      process.exit(0)
    } catch (err) {
      clearTimeout(forceExitTimer)
      logger.error({ err, signal }, 'error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
