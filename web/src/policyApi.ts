import type { Policy, PolicyDraft } from './policyTypes'

/**
 * `set_policy`'s UI talks to the merchant API (`src/adapters/merchant-api/`),
 * a *different* deployed service from the one this viewer is served by
 * (docs/07-deployment.md's three-service topology) — unlike `/events`, this
 * is genuinely cross-origin in production, which is why the merchant API now
 * registers CORS (`src/adapters/merchant-api/server.ts`). Locally, an unset
 * `VITE_MERCHANT_API_URL` falls back to a relative path, proxied by Vite
 * (`vite.config.ts`) the same way `/events` already is.
 */
const MERCHANT_API_URL = (import.meta.env['VITE_MERCHANT_API_URL'] as string | undefined) ?? ''

export class PolicyApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'PolicyApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${MERCHANT_API_URL}${path}`, {
    ...init,
    headers: { ...init?.headers, authorization: `Bearer ${token}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string }
    throw new PolicyApiError(response.status, body.error ?? `request failed with ${response.status}`, body.code)
  }
  return (await response.json()) as T
}

export function fetchActivePolicy(token: string): Promise<{ policy: Policy }> {
  return request('/policy', token)
}

export function publishPolicy(token: string, draft: PolicyDraft): Promise<{ policy: Policy }> {
  return request('/policy', token, { method: 'POST', body: JSON.stringify(draft) })
}
