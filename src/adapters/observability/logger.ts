import { readFileSync } from 'node:fs'
import pino from 'pino'
import type { Logger } from '../../ports/logger.js'

const packageVersion: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/**
 * One Pino instance per process, built once at each entrypoint's top level —
 * the same "one X per process" shape `circuit-breaker.ts` uses for its own
 * cross-cutting infra. `service` distinguishes latch-mcp / latch-merchant-api
 * / latch-viewer / latch-worker-* in a shared log sink. Pino's own logger
 * type structurally satisfies `ports/logger.ts`'s narrower `Logger`
 * interface, so no wrapper class is needed here — `pino()` is returned
 * directly.
 *
 * `destination` defaults to stdout (fd 1) for every HTTP/worker process. The
 * one exception is `mcp/stdio.ts`: stdout there **is** the MCP JSON-RPC
 * transport, so a log line written to fd 1 would corrupt the protocol
 * stream. That entrypoint must pass `destination: 2` (stderr) explicitly —
 * see its own call site.
 */
export function createLogger(service: string, destination: 1 | 2 = 1): Logger {
  const isProd = process.env['NODE_ENV'] === 'production'
  const base = { service, environment: process.env['NODE_ENV'] ?? 'development', version: packageVersion }
  const level = process.env['LOG_LEVEL'] ?? 'info'

  if (isProd) {
    return pino({ level, base }, pino.destination(destination))
  }

  return pino({
    level,
    base,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname', destination },
    },
  })
}
