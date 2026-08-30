import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `loadEnv()` caches its result in a module-level variable (deliberately —
 * see its own doc comment: parsed once, not re-parsed on every call). Each
 * test here needs its own fresh module instance to test a different
 * `process.env` shape, hence `vi.resetModules()` + a dynamic re-import
 * rather than the top-level static import this codebase otherwise always
 * uses — the one legitimate reason to reach for it.
 */
const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.resetModules()
})

async function freshLoadEnv() {
  vi.resetModules()
  const mod = await import('./config.js')
  return mod.loadEnv
}

describe('loadEnv', () => {
  it('applies documented defaults when nothing is set beyond DATABASE_URL', async () => {
    process.env = { DATABASE_URL: 'postgres://x' }
    const loadEnv = await freshLoadEnv()

    const env = loadEnv()

    expect(env.MCP_HTTP_PORT).toBe(4000)
    expect(env.DB_POOL_MAX).toBe(5)
    expect(env.MCP_RATE_LIMIT_MAX).toBe(300)
    expect(env.BACKGROUND_WORKER_INTERVAL_MS).toBe(60_000)
    expect(env.GRACEFUL_SHUTDOWN_TIMEOUT_MS).toBe(10_000)
    expect(env.DB_TRANSACTION_POOLER).toBe(false)
    expect(env.OTEL_ENABLED).toBe(false)
  })

  it('coerces numeric env vars from strings', async () => {
    process.env = { DATABASE_URL: 'postgres://x', DB_POOL_MAX: '20', MCP_HTTP_PORT: '5000' }
    const loadEnv = await freshLoadEnv()

    const env = loadEnv()

    expect(env.DB_POOL_MAX).toBe(20)
    expect(env.MCP_HTTP_PORT).toBe(5000)
  })

  it('rejects a non-numeric value with a clear error rather than producing NaN', async () => {
    process.env = { DATABASE_URL: 'postgres://x', DB_POOL_MAX: 'not-a-number' }
    const loadEnv = await freshLoadEnv()

    expect(() => loadEnv()).toThrow(/DB_POOL_MAX/)
  })

  it('DB_TRANSACTION_POOLER only turns on for the literal string "true" — not any other truthy-looking value', async () => {
    process.env = { DATABASE_URL: 'postgres://x', DB_TRANSACTION_POOLER: 'yes' }
    const loadEnv = await freshLoadEnv()

    // "yes" isn't in the enum ['true', 'false'] the schema accepts.
    expect(() => loadEnv()).toThrow(/DB_TRANSACTION_POOLER/)
  })

  it('DB_TRANSACTION_POOLER="false" resolves to false, not true', async () => {
    process.env = { DATABASE_URL: 'postgres://x', DB_TRANSACTION_POOLER: 'false' }
    const loadEnv = await freshLoadEnv()

    expect(loadEnv().DB_TRANSACTION_POOLER).toBe(false)
  })

  it('requires RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET when PAYMENT_PROVIDER=razorpay', async () => {
    process.env = { DATABASE_URL: 'postgres://x', PAYMENT_PROVIDER: 'razorpay' }
    const loadEnv = await freshLoadEnv()

    expect(() => loadEnv()).toThrow(/RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET/)
  })

  it('accepts PAYMENT_PROVIDER=razorpay once both Razorpay keys are present', async () => {
    process.env = { DATABASE_URL: 'postgres://x', PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'id', RAZORPAY_KEY_SECRET: 'secret' }
    const loadEnv = await freshLoadEnv()

    expect(() => loadEnv()).not.toThrow()
  })

  it('rejects an unrecognised PAYMENT_PROVIDER value instead of silently falling back to the fake provider', async () => {
    process.env = { DATABASE_URL: 'postgres://x', PAYMENT_PROVIDER: 'Razorpay' } // wrong case — a real typo this should catch
    const loadEnv = await freshLoadEnv()

    expect(() => loadEnv()).toThrow(/PAYMENT_PROVIDER/)
  })

  it('DATABASE_URL is optional at this layer — requireDatabaseUrl (build-deps.ts) is what enforces it for real entrypoints', async () => {
    process.env = {}
    const loadEnv = await freshLoadEnv()

    expect(() => loadEnv()).not.toThrow()
    expect(loadEnv().DATABASE_URL).toBeUndefined()
  })

  it('caches the parsed result — a second call does not re-read process.env', async () => {
    process.env = { DATABASE_URL: 'postgres://x', MCP_HTTP_PORT: '4000' }
    const loadEnv = await freshLoadEnv()

    const first = loadEnv()
    process.env['MCP_HTTP_PORT'] = '9999'
    const second = loadEnv()

    expect(second.MCP_HTTP_PORT).toBe(4000)
    expect(second).toBe(first)
  })
})
