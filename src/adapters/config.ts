import { z } from 'zod'

/**
 * dev-logs/023. Every env var this codebase actually reads (audited via
 * `grep -rn "process.env" src`), in one Zod schema, validated once at
 * process startup instead of scattered across a dozen `Number(process.env[
 * 'X'] ?? default)`/`process.env['Y'] === 'z'` call sites that each fail
 * differently (or silently misbehave) on a bad value. `loadEnv()` must be
 * called *after* `loadEnvFile()` — see its own doc comment — every
 * entrypoint already follows that order for `requireDatabaseUrl()` and
 * friends; this replaces those scattered reads, not the call order.
 *
 * Deliberately **not** exposing every internal timing constant as env-
 * configurable, even though the spec this was requested from suggested
 * "idempotency/circuit-breaker/shutdown timeouts" as a single group. Some of
 * those are deployment tuning (this module's `GRACEFUL_SHUTDOWN_TIMEOUT_MS`
 * below); others are safety margins a bad value could silently defeat — the
 * idempotency cleanup worker's `PENDING_MAX_AGE_MS` (dev-logs/021) must stay
 * well above the longest legitimate claim duration or GC can delete a row a
 * live claimant still owns and reopen dev-logs/013's race, and the payment
 * circuit breaker's `failureThreshold`/`cooldownMs` (dev-logs/020) are tuned
 * against a specific "customer decline vs. real outage" distinction. Both
 * stay hardcoded, with their own reasoning attached where they're defined,
 * not lifted into something an operator could misconfigure into a
 * correctness bug.
 */
const envSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
    /**
     * Optional *in this schema* — deliberately not `.min(1, ...)`-required
     * here. `build-deps.ts`'s `requireDatabaseUrl()` is what actually
     * enforces this for every real entrypoint, with its own clear error;
     * keeping it optional in the general schema means calling `loadEnv()`
     * for an unrelated field (`createDbClient` calling it for `DB_POOL_MAX`
     * etc.) never fails just because `DATABASE_URL` isn't in `process.env` —
     * which matters for integration tests, ~20 of which resolve their own
     * `databaseUrl` via a local `process.env['DATABASE_URL'] ?? '...'`
     * fallback and pass it straight to `createDbClient` as a parameter,
     * without ever writing it back into `process.env`.
     */
    DATABASE_URL: z.string().optional(),

    // Railway injects PORT per service; the four *_PORT vars are each
    // service's local-dev-only fallback (docs/07-deployment.md: "None of
    // the three set PORT — Railway injects it per service").
    PORT: z.coerce.number().int().positive().optional(),
    MCP_HTTP_PORT: z.coerce.number().int().positive().optional().default(4000),
    MERCHANT_API_PORT: z.coerce.number().int().positive().optional().default(4001),
    AUDIT_TRAIL_PORT: z.coerce.number().int().positive().optional().default(4002),
    REST_PORT: z.coerce.number().int().positive().optional().default(4003),

    // dev-logs/006: opt-in, never automatic just because keys are present.
    PAYMENT_PROVIDER: z.enum(['razorpay']).optional(),
    // dev-logs/005/007: not a supported runtime mode — ReservePayRail throws
    // on first use. Kept as a real option here (not silently rejected by the
    // schema) because its whole purpose is proving the swap is a module
    // boundary, not a rewrite.
    PAYMENT_RAIL: z.enum(['reserve_pay']).optional(),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    // dev-logs/014: undefined disables POST /webhooks/razorpay (503) rather
    // than crashing merchant-api on boot.
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

    /**
     * Payment-link feature (dev-logs entry for this slice). The public
     * origin `confirm_with_deposit` builds pay links against —
     * `GET /pay/:bookingId` is served by `audit-trail/server.ts`
     * (docs/07-deployment.md: `latch-viewer`'s own public URL in
     * production). Undefined falls back to `http://localhost:${AUDIT_TRAIL_PORT}`
     * for local dev (`build-deps.ts`).
     */
    PAY_PAGE_BASE_URL: z.string().optional(),

    MERCHANT_ID: z.string().optional(),

    DB_POOL_MAX: z.coerce.number().int().positive().optional().default(5),
    DB_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().nonnegative().optional().default(60),
    DB_MAX_LIFETIME_SECONDS: z.coerce.number().int().nonnegative().optional().default(30 * 60),
    // Preserves the exact existing semantic (`=== 'true'`, everything else —
    // including "false" — is off) rather than `z.coerce.boolean()`, which
    // would treat the literal string "false" as truthy.
    DB_TRANSACTION_POOLER: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),

    MCP_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional().default(300),
    MCP_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().optional().default(60_000),

    BACKGROUND_WORKER_INTERVAL_MS: z.coerce.number().int().positive().optional().default(60_000),
    AUTHORIZATION_LAPSE_WORKER_INTERVAL_MS: z.coerce.number().int().positive().optional().default(60_000),
    RECONCILIATION_WORKER_INTERVAL_MS: z.coerce.number().int().positive().optional().default(60_000),

    /** dev-logs/024. Off by default — real cost (a live OTel SDK, span export) that most local dev runs and every test run shouldn't pay for something they're not looking at. */
    OTEL_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
    /** Undefined -> spans print to the console (dev). Set for a real collector (Jaeger, Datadog's OTLP ingest, ...) in any deployed environment. */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    /**
     * dev-logs/024. `undefined` keeps `merchant-api/server.ts`'s existing
     * default (`origin: true` — reflect the caller's own Origin; real
     * authorization is still the Bearer-token hook, CORS only governs which
     * origins JavaScript may *read* a response — dev-logs/015's own
     * reasoning for that route, unchanged here). A comma-separated list
     * restricts it to exactly those origins instead.
     */
    CORS_ALLOWED_ORIGINS: z.string().optional(),

    GRACEFUL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(10_000),
  })
  .superRefine((val, ctx) => {
    if (val.PAYMENT_PROVIDER === 'razorpay' && (!val.RAZORPAY_KEY_ID || !val.RAZORPAY_KEY_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['RAZORPAY_KEY_ID'], message: 'PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to both be set' })
    }
  })

export type Env = z.infer<typeof envSchema>

let cached: Env | undefined

/**
 * Call once, after `loadEnvFile()` — every entrypoint already calls that
 * first, before touching `process.env` (`.env` only exists on a local dev
 * machine; a real deployment injects vars directly, `load-env.ts`'s own
 * comment). Parsing here instead of at this module's top level is not a
 * style choice: this module is statically imported before an entrypoint's
 * own body runs `loadEnvFile()`, so parsing eagerly at import time would
 * read `process.env` before `.env` has been loaded into it, silently
 * missing every local-only override.
 */
export function loadEnv(): Env {
  if (cached) return cached
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const message = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${message}`)
  }
  cached = result.data
  return cached
}
