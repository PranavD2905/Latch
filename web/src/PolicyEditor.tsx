import { useEffect, useState } from 'react'
import { fetchActivePolicy, fetchServices, PolicyApiError, publishPolicy, updateService } from './policyApi'
import type { LadderTier, Policy, PolicyDraft, Service } from './policyTypes'
import { draftFromPolicy, validateDraft } from './policyTypes'
import { formatRupees } from './types'

const TOKEN_KEY = 'latch_merchant_token'

const DEFAULT_DRAFT: PolicyDraft = {
  depositAmountPaise: 30_000,
  cancellationLadder: [
    { hoursBefore: 48, retainPct: 0 },
    { hoursBefore: 12, retainPct: 50 },
    { hoursBefore: 0, retainPct: 100 },
  ],
  holdTtlSeconds: 600,
  maxConcurrentHoldsPerAgent: 3,
  holdRateLimitPerMinute: 10,
}

function retainedOf(amountPaise: number, pct: number): number {
  return Math.floor((amountPaise * pct) / 100)
}

const INPUT = 'w-full rounded-lg border border-[var(--border-strong)] bg-white px-3 py-2 text-[13px] outline-none focus:border-[var(--blue)]'
const LABEL = 'text-[12px] font-medium text-[var(--text-muted)]'
const FIELD = 'flex flex-col gap-1'

function NumberField({ label, value, onChange, hint }: { label: string; value: number; onChange: (n: number) => void; hint?: string }) {
  return (
    <label className={FIELD}>
      <span className={LABEL}>{label}</span>
      <input type="number" className={INPUT} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.valueAsNumber)} />
      {hint && <span className="text-[11px] text-[var(--text-faint)]">{hint}</span>}
    </label>
  )
}

function LadderEditor({ ladder, onChange }: { ladder: readonly LadderTier[]; onChange: (next: LadderTier[]) => void }) {
  function updateTier(i: number, patch: Partial<LadderTier>) {
    onChange(ladder.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))
  }
  function removeTier(i: number) {
    onChange(ladder.filter((_, idx) => idx !== i))
  }
  function addTier() {
    const insertBefore = Math.max(ladder.length - 1, 0)
    const anchor = ladder[insertBefore - 1] ?? ladder[insertBefore] ?? { hoursBefore: 24, retainPct: 0 }
    const next = [...ladder]
    next.splice(insertBefore, 0, { hoursBefore: anchor.hoursBefore + 12, retainPct: anchor.retainPct })
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 text-[11px] font-medium text-[var(--text-faint)]">
        <span>Hours before appointment</span>
        <span>% of deposit retained</span>
        <span></span>
        <span></span>
      </div>
      {ladder.map((tier, i) => {
        const isFloor = i === ladder.length - 1
        return (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2">
            <input
              type="number"
              className={INPUT}
              value={tier.hoursBefore}
              readOnly={isFloor}
              disabled={isFloor}
              title={isFloor ? 'The floor tier always sits at 0 — it catches every cancellation from here down to (and past) the appointment.' : undefined}
              onChange={(e) => updateTier(i, { hoursBefore: e.target.valueAsNumber })}
            />
            <input type="number" className={INPUT} value={tier.retainPct} onChange={(e) => updateTier(i, { retainPct: e.target.valueAsNumber })} />
            <span className="text-[11px] text-[var(--text-faint)]">{isFloor ? 'floor' : ''}</span>
            <button
              type="button"
              onClick={() => removeTier(i)}
              disabled={ladder.length <= 1}
              className="rounded-md px-2 py-1.5 text-[12px] text-[var(--text-faint)] hover:bg-[var(--slate-bg)] hover:text-[var(--critical-text)] disabled:opacity-30"
            >
              Remove
            </button>
          </div>
        )
      })}
      <button type="button" onClick={addTier} className="mt-1 w-fit rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-muted)] hover:border-[var(--blue)] hover:text-[var(--blue-text)]">
        + Add tier
      </button>
    </div>
  )
}

/** The computed-consequence callout — dev-logs/015: surfaces the number that falls out of the deposit + ladder, without changing what's actually charged. Used to also cover an independent no-show fee — removed along with that feature; deposit forfeiture per the ladder below is the recovery mechanism for a no-show now. */
function ConsequencePreview({ draft }: { draft: PolicyDraft }) {
  return (
    <div className="rounded-xl border border-[var(--warning)] bg-[var(--warning-bg)] p-4">
      <div className="text-[13px] font-semibold text-[var(--warning-text)]">What a no-show actually costs this patient</div>
      <div className="mt-1 text-[13px] text-[var(--text-muted)]">
        A no-show forfeits the deposit per the ladder below (the floor tier retains it in full). A patient who does attend is instead charged the session-complete mandate (each service's price minus this deposit) when the merchant marks the session done.
      </div>
      <div className="mt-3 grid grid-cols-1 gap-1 border-t border-[var(--warning)]/30 pt-3 sm:grid-cols-3">
        {draft.cancellationLadder.map((tier, i) => (
          <div key={i} className="text-[12px] text-[var(--text-muted)]">
            <span className="font-mono font-semibold text-[var(--text)]">{tier.hoursBefore}h+</span> before: retains {formatRupees(retainedOf(draft.depositAmountPaise, tier.retainPct))}, refunds{' '}
            {formatRupees(draft.depositAmountPaise - retainedOf(draft.depositAmountPaise, tier.retainPct))}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The session-complete mandate is per-service (`service.pricePaise -
 * depositAmountPaise`), so this needs the merchant's own deposit figure to
 * show what each service's mandate actually comes out to — same "computed
 * consequence, not a stored number" idea `ConsequencePreview` already uses.
 */
function ServicesEditor({ token, depositAmountPaise }: { token: string; depositAmountPaise: number }) {
  const [services, setServices] = useState<Service[] | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    fetchServices(token)
      .then(({ services }) => {
        if (cancelled) return
        setServices(services)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [token])

  async function handleSave(service: Service) {
    const raw = drafts[service.serviceId]
    const pricePaise = raw === undefined ? service.pricePaise : Number(raw)
    if (!Number.isInteger(pricePaise) || pricePaise < 0) {
      setError(`${service.name}: price must be a non-negative whole number of paise.`)
      return
    }
    setSavingId(service.serviceId)
    setError(undefined)
    try {
      const { service: updated } = await updateService(token, service.serviceId, { pricePaise })
      setServices((prev) => (prev ? prev.map((s) => (s.serviceId === updated.serviceId ? updated : s)) : prev))
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[service.serviceId]
        return next
      })
    } catch (err) {
      setError(err instanceof PolicyApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setSavingId(undefined)
    }
  }

  if (error && !services) {
    return <div className="rounded-lg border border-[var(--critical)] bg-[var(--critical-bg)] px-4 py-3 text-[13px] text-[var(--critical-text)]">Could not load services: {error}</div>
  }
  if (!services) {
    return <div className="px-2 py-4 text-center font-mono text-sm text-[var(--text-faint)]">loading services…</div>
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div className="text-[14px] font-semibold text-[var(--text)]">Services &amp; pricing</div>
      <div className="mt-1 text-[12px] text-[var(--text-faint)]">
        Each service's price is the "total charge" the session-complete mandate is computed from (price − deposit), authorised when a booking is confirmed and captured when the merchant marks the
        session complete. Editing a price here only affects bookings confirmed after the change — an already-confirmed booking's mandate is frozen at whatever the price was when it was confirmed.
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {services.map((service) => {
          const draftValue = drafts[service.serviceId] ?? String(service.pricePaise)
          const mandatePaise = Number(draftValue) - depositAmountPaise
          const dirty = drafts[service.serviceId] !== undefined && Number(drafts[service.serviceId]) !== service.pricePaise
          return (
            <div key={service.serviceId} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 rounded-lg border border-[var(--border)] p-3">
              <div>
                <div className="text-[13px] font-medium text-[var(--text)]">{service.name}</div>
                <div className="text-[11px] text-[var(--text-faint)]">{service.durationMinutes} min</div>
              </div>
              <input
                type="number"
                className={`${INPUT} w-32`}
                value={draftValue}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [service.serviceId]: e.target.value }))}
              />
              <span className="text-[11px] whitespace-nowrap text-[var(--text-faint)]">
                {Number.isFinite(mandatePaise) ? `mandate ${formatRupees(Math.max(mandatePaise, 0))}` : ''}
                {Number.isFinite(mandatePaise) && mandatePaise < 0 ? ' ⚠ below deposit' : ''}
              </span>
              <button
                type="button"
                onClick={() => handleSave(service)}
                disabled={!dirty || savingId === service.serviceId}
                className="rounded-lg bg-[var(--text)] px-3 py-1.5 text-[12px] font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {savingId === service.serviceId ? 'Saving…' : 'Save'}
              </button>
            </div>
          )
        })}
      </div>
      {error && <div className="mt-3 rounded-lg border border-[var(--critical)] bg-[var(--critical-bg)] px-3 py-2 text-[12px] text-[var(--critical-text)]">{error}</div>}
    </div>
  )
}

function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="mx-auto mt-16 max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
      <div className="text-[15px] font-semibold text-[var(--text)]">Merchant sign-in</div>
      <div className="mt-1 text-[13px] text-[var(--text-muted)]">Publishing a policy needs the merchant API token. It's kept only in this browser tab's session storage — never sent anywhere but the merchant API, and never baked into this page.</div>
      <form
        className="mt-4 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSubmit(value.trim())
        }}
      >
        <input type="password" className={INPUT} placeholder="Merchant API token" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="rounded-lg bg-[var(--text)] px-3 py-2 text-[13px] font-medium text-white transition hover:opacity-90">
          Continue
        </button>
      </form>
    </div>
  )
}

export function PolicyEditor() {
  const [token, setToken] = useState<string>(() => sessionStorage.getItem(TOKEN_KEY) ?? '')
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [draft, setDraft] = useState<PolicyDraft | null>(null)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'not-found' | 'error'>('idle')
  const [loadError, setLoadError] = useState<string | undefined>()
  const [confirming, setConfirming] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | undefined>()
  const [justPublished, setJustPublished] = useState<number | undefined>()

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setLoadState('loading')
    fetchActivePolicy(token)
      .then(({ policy }) => {
        if (cancelled) return
        setPolicy(policy)
        setDraft(draftFromPolicy(policy))
        setLoadState('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof PolicyApiError && err.status === 401) {
          sessionStorage.removeItem(TOKEN_KEY)
          setToken('')
          setLoadState('idle')
          return
        }
        if (err instanceof PolicyApiError && err.status === 404) {
          setPolicy(null)
          setDraft(DEFAULT_DRAFT)
          setLoadState('not-found')
          return
        }
        setLoadError(err instanceof Error ? err.message : String(err))
        setLoadState('error')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  function handleSignOut() {
    sessionStorage.removeItem(TOKEN_KEY)
    setToken('')
    setPolicy(null)
    setDraft(null)
    setLoadState('idle')
  }

  async function handlePublish() {
    if (!draft) return
    setPublishing(true)
    setPublishError(undefined)
    try {
      const { policy: newPolicy } = await publishPolicy(token, draft)
      setPolicy(newPolicy)
      setDraft(draftFromPolicy(newPolicy))
      setJustPublished(newPolicy.policyVersion)
      setConfirming(false)
    } catch (err) {
      if (err instanceof PolicyApiError) {
        setPublishError(err.code ? `${err.message} (${err.code})` : err.message)
      } else {
        setPublishError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setPublishing(false)
    }
  }

  if (!token) {
    return (
      <TokenGate
        onSubmit={(t) => {
          sessionStorage.setItem(TOKEN_KEY, t)
          setToken(t)
        }}
      />
    )
  }

  if (loadState === 'loading' || loadState === 'idle') {
    return <div className="px-6 py-16 text-center font-mono text-sm text-[var(--text-faint)]">loading the active policy…</div>
  }

  if (loadState === 'error') {
    return (
      <div className="mx-6 mt-6 rounded-lg border border-[var(--critical)] bg-[var(--critical-bg)] px-4 py-3 text-[13px] text-[var(--critical-text)]">
        Could not reach the merchant API: {loadError}
      </div>
    )
  }

  if (!draft) return null
  const validationError = validateDraft(draft)
  const nextVersion = (policy?.policyVersion ?? 0) + 1
  const hasChanges = policy ? JSON.stringify(draftFromPolicy(policy)) !== JSON.stringify(draft) : true

  return (
    <div className="flex flex-col gap-4 px-6 py-6">
      <div className="flex items-center justify-between">
        <div>
          {policy ? (
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-[var(--text)] px-2 py-1 font-mono text-[12px] font-semibold text-white">v{policy.policyVersion}</span>
              <span className="text-[13px] text-[var(--text-muted)]">is the active policy — every new booking cites this version</span>
            </div>
          ) : (
            <span className="text-[13px] text-[var(--warning-text)]">No policy has been published for this merchant yet.</span>
          )}
        </div>
        <button onClick={handleSignOut} className="text-[12px] text-[var(--text-faint)] hover:text-[var(--text)]">
          Sign out
        </button>
      </div>

      {justPublished !== undefined && (
        <div className="rounded-lg border border-[var(--good)] bg-[var(--good-bg)] px-4 py-3 text-[13px] text-[var(--good-text)]">
          Published v{justPublished}. It's immutable from here — a booking confirmed under an older version keeps cancelling under that version, forever.
        </div>
      )}

      <ConsequencePreview draft={draft} />

      <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 lg:grid-cols-2">
        <NumberField label="Deposit (paise)" value={draft.depositAmountPaise} onChange={(n) => setDraft({ ...draft, depositAmountPaise: n })} hint={formatRupees(draft.depositAmountPaise || 0)} />
        <div />

        <NumberField label="Hold TTL (seconds)" value={draft.holdTtlSeconds} onChange={(n) => setDraft({ ...draft, holdTtlSeconds: n })} />
        <NumberField label="Max concurrent holds / agent" value={draft.maxConcurrentHoldsPerAgent} onChange={(n) => setDraft({ ...draft, maxConcurrentHoldsPerAgent: n })} />
        <NumberField label="Hold rate limit / minute / agent" value={draft.holdRateLimitPerMinute} onChange={(n) => setDraft({ ...draft, holdRateLimitPerMinute: n })} />

        <div className="lg:col-span-2">
          <div className={LABEL}>Cancellation ladder</div>
          <div className="mt-1">
            <LadderEditor ladder={draft.cancellationLadder} onChange={(next) => setDraft({ ...draft, cancellationLadder: next })} />
          </div>
        </div>
      </div>

      <ServicesEditor token={token} depositAmountPaise={draft.depositAmountPaise} />

      {validationError && <div className="rounded-lg border border-[var(--critical)] bg-[var(--critical-bg)] px-4 py-2 text-[13px] text-[var(--critical-text)]">{validationError}</div>}
      {publishError && <div className="rounded-lg border border-[var(--critical)] bg-[var(--critical-bg)] px-4 py-2 text-[13px] text-[var(--critical-text)]">{publishError}</div>}

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          disabled={!!validationError || !hasChanges}
          className="w-fit rounded-lg bg-[var(--text)] px-4 py-2.5 text-[13px] font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Publish as v{nextVersion}
        </button>
      ) : (
        <div className="rounded-xl border border-[var(--border-strong)] bg-white p-4">
          <div className="text-[13px] font-medium text-[var(--text)]">
            Publish v{nextVersion}? This adds a new version — it does not edit v{policy?.policyVersion ?? '—'}. Any booking already confirmed keeps cancelling under whichever
            version it was confirmed under.
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handlePublish}
              disabled={publishing}
              className="rounded-lg bg-[var(--critical-text)] px-3 py-2 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {publishing ? 'Publishing…' : `Confirm — publish v${nextVersion}`}
            </button>
            <button onClick={() => setConfirming(false)} disabled={publishing} className="rounded-lg border border-[var(--border-strong)] px-3 py-2 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--slate-bg)]">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
