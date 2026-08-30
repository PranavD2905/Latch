/**
 * Structured logging port — `src/app/*.ts` depends on this shape only, never
 * on Pino directly (the same hexagonal discipline `Clock` follows). `child`
 * is how a request-scoped field (a trace id) rides along on every log line
 * without every call site having to pass it explicitly.
 */
export interface Logger {
  debug(fields: Record<string, unknown>, msg: string): void
  info(fields: Record<string, unknown>, msg: string): void
  warn(fields: Record<string, unknown>, msg: string): void
  error(fields: Record<string, unknown>, msg: string): void
  child(bindings: Record<string, unknown>): Logger
}
