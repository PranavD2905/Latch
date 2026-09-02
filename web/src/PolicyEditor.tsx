import { useEffect, useState } from 'react'
import { fetchActivePolicy, fetchServices, PolicyApiError, publishPolicy, updateService } from './policyApi'
import type { LadderTier, Policy, PolicyDraft, Service } from './policyTypes'
import { draftFromPolicy, validateDraft } from './policyTypes'
import { AlertIcon, CheckCircleIcon } from './icons'
import { formatRupeesFixed } from './types'

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

function durationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${Math.floor(seconds / 60)} min ${seconds % 60}s`
}

/* ---------- shared panel furniture ---------- */

function Panel({ title, note, children, id }: { title: string; note?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section className="card scroll-mt-20" id={id}>
      <div className="px-5 pt-5">
        <h2 className="text-[length:var(--t-base)] font-semibold text-[var(--text)]">{title}</h2>
        {note && <p className="mt-1 max-w-[78ch] text-[length:var(--t-sm)] leading-relaxed text-[var(--text-muted)]">{note}</p>}
      </div>
      <div className="px-5 pb-5 pt-4">{children}</div>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[length:var(--t-xs)] font-medium text-[var(--text-muted)]">{label}</span>
      {children}
      {hint && <span className="text-[length:var(--t-2xs)] text-[var(--text-muted)]">{hint}</span>}
    </label>
  )
}

function NumberField({ label, value, onChange, hint, suffix }: { label: string; value: number; onChange: (n: number) => void; hint?: React.ReactNode; suffix?: string }) {
  return (
    <Field label={label} hint={hint}>
      <span className="relative flex items-center">
        <input
          type="number"
          className="control tabular-nums"
          style={suffix ? { paddingRight: `${suffix.length * 0.58 + 1.1}rem` } : undefined}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(e.target.valueAsNumber)}
        />
        {suffix && <span className="pointer-events-none absolute right-2.5 text-[length:var(--t-2xs)] text-[var(--text-muted)]">{suffix}</span>}
      </span>
    </Field>
  )
}

/* ---------- the ladder ---------- */

/**
 * Each tier shows the money it produces, not just the percentage that
 * produces it. A merchant setting "50%" is really deciding "₹150 kept, ₹150
 * back" — so that's what the row says, recomputed as they type. The floor
 * tier is locked at 0h: it's the catch-all that covers right up to and past
 * the appointment, and letting it move is the single easiest way to publish
 * a ladder with a hole in it.
 */
function LadderEditor({ ladder, depositPaise, onChange }: { ladder: readonly LadderTier[]; depositPaise: number; onChange: (next: LadderTier[]) => void }) {
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
      <div className="grid grid-cols-[7rem_6rem_1fr_auto] items-center gap-3 px-3 text-[length:var(--t-2xs)] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
        <span>Hours before</span>
        <span>Retained</span>
        <span>What that means</span>
        <span />
      </div>

      {ladder.map((tier, i) => {
        const isFloor = i === ladder.length - 1
        const kept = retainedOf(depositPaise || 0, tier.retainPct)
        const back = (depositPaise || 0) - kept
        const validPct = Number.isFinite(tier.retainPct) && tier.retainPct >= 0 && tier.retainPct <= 100
        return (
          <div
            key={i}
            className="grid grid-cols-[7rem_6rem_1fr_auto] items-center gap-3 rounded-[var(--r-control)] border border-[var(--border)] bg-[var(--surface-sunk)] px-3 py-2.5"
          >
            <span className="relative flex items-center">
              <input
                type="number"
                className="control tabular-nums"
                value={Number.isFinite(tier.hoursBefore) ? tier.hoursBefore : ''}
                readOnly={isFloor}
                disabled={isFloor}
                aria-label={`Tier ${i + 1} hours before appointment`}
                title={isFloor ? 'The floor tier always sits at 0 — it catches every cancellation from here down to (and past) the appointment.' : undefined}
                onChange={(e) => updateTier(i, { hoursBefore: e.target.valueAsNumber })}
              />
            </span>
            <span className="relative flex items-center">
              <input
                type="number"
                className="control pr-6 tabular-nums"
                value={Number.isFinite(tier.retainPct) ? tier.retainPct : ''}
                aria-label={`Tier ${i + 1} percent of deposit retained`}
                onChange={(e) => updateTier(i, { retainPct: e.target.valueAsNumber })}
              />
              <span className="pointer-events-none absolute right-2.5 text-[length:var(--t-2xs)] text-[var(--text-muted)]">%</span>
            </span>

            <span className="min-w-0 text-[length:var(--t-xs)] text-[var(--text-muted)]">
              {validPct ? (
                <>
                  merchant keeps <span className="font-semibold text-[var(--text)]">{formatRupeesFixed(kept)}</span>, patient gets{' '}
                  <span className="font-semibold" style={{ color: back > 0 ? 'var(--good-text)' : 'var(--text)' }}>
                    {formatRupeesFixed(back)}
                  </span>{' '}
                  back
                  {isFloor && <span className="ml-1.5 text-[var(--text-muted)]">· floor tier, covers the appointment itself</span>}
                </>
              ) : (
                <span className="text-[var(--critical-text)]">retained % must be 0–100</span>
              )}
            </span>

            <button
              type="button"
              onClick={() => removeTier(i)}
              disabled={ladder.length <= 1}
              aria-label={`Remove tier ${i + 1}`}
              className="btn btn-ghost px-2 py-1 text-[length:var(--t-xs)] hover:text-[var(--critical-text)]"
            >
              Remove
            </button>
          </div>
        )
      })}

      <button
        type="button"
        onClick={addTier}
        className="mt-1 w-fit rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-1.5 text-[length:var(--t-xs)] font-medium text-[var(--text-muted)] transition-colors duration-[var(--dur)] hover:border-[var(--blue)] hover:text-[var(--blue-hover)]"
      >
        + Add tier
      </button>
    </div>
  )
}

/* ---------- services ---------- */

/**
 * The session-complete mandate is per-service (`service.pricePaise -
 * depositAmountPaise`), so this needs the merchant's own deposit figure to
 * show what each service's mandate actually comes out to — same "computed
 * consequence, not a stored number" idea the ladder rows use.
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

  const note = (
    <>
      A service&apos;s price is what the session-complete mandate is computed from (price − deposit): authorised when a booking is confirmed, captured when the
      merchant marks the session done. Editing a price only affects bookings confirmed after the change — an already-confirmed booking&apos;s mandate is frozen
      at the price it was confirmed under.
    </>
  )

  if (error && !services) {
    return (
      <Panel title="Services &amp; pricing" note={note}>
        <Alert tone="critical">Could not load services: {error}</Alert>
      </Panel>
    )
  }

  if (!services) {
    return (
      <Panel title="Services &amp; pricing" note={note}>
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading services">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[58px] animate-pulse rounded-lg bg-[var(--neutral-bg)]" />
          ))}
        </div>
      </Panel>
    )
  }

  return (
    <Panel title="Services &amp; pricing" note={note}>
      <div className="flex flex-col gap-2">
        {services.map((service) => {
          const draftValue = drafts[service.serviceId] ?? String(service.pricePaise)
          const mandatePaise = Number(draftValue) - depositAmountPaise
          const dirty = drafts[service.serviceId] !== undefined && Number(drafts[service.serviceId]) !== service.pricePaise
          const belowDeposit = Number.isFinite(mandatePaise) && mandatePaise < 0
          return (
            <div
              key={service.serviceId}
              className="flex flex-wrap items-center gap-3 rounded-[var(--r-control)] border border-[var(--border)] bg-[var(--surface-sunk)] px-3 py-2.5"
            >
              <div className="min-w-[9rem] flex-1">
                <div className="text-[length:var(--t-sm)] font-medium text-[var(--text)]">{service.name}</div>
                <div className="text-[length:var(--t-2xs)] text-[var(--text-muted)]">
                  {service.durationMinutes} min · {shortServiceId(service.serviceId)}
                </div>
              </div>

              <span className="relative flex items-center">
                <input
                  type="number"
                  className="control w-36 pr-11 tabular-nums"
                  aria-label={`${service.name} price in paise`}
                  value={draftValue}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [service.serviceId]: e.target.value }))}
                />
                <span className="pointer-events-none absolute right-2.5 text-[length:var(--t-2xs)] text-[var(--text-muted)]">paise</span>
              </span>

              <div className="min-w-[10rem] text-[length:var(--t-xs)]">
                <div className="text-[var(--text)]">{Number.isFinite(Number(draftValue)) ? formatRupeesFixed(Number(draftValue)) : '—'}</div>
                <div style={{ color: belowDeposit ? 'var(--critical-text)' : 'var(--text-muted)' }}>
                  {belowDeposit ? '⚠ price is below the deposit' : Number.isFinite(mandatePaise) ? `mandate ${formatRupeesFixed(Math.max(mandatePaise, 0))}` : ''}
                </div>
              </div>

              {/* An untouched row needs a resting state, not a greyed-out button — a disabled primary reads as "something is wrong here". */}
              {dirty || savingId === service.serviceId ? (
                <button type="button" onClick={() => handleSave(service)} disabled={savingId === service.serviceId} className="btn btn-primary min-w-[5.25rem]">
                  {savingId === service.serviceId ? 'Saving…' : 'Save'}
                </button>
              ) : (
                <span className="flex min-w-[5.25rem] items-center justify-center gap-1.5 px-2 text-[length:var(--t-xs)] text-[var(--text-muted)]">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  Saved
                </span>
              )}
            </div>
          )
        })}
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="critical">{error}</Alert>
        </div>
      )}
    </Panel>
  )
}

function shortServiceId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id
}

/* ---------- messaging ---------- */

const ALERT_TONE = {
  critical: { bg: 'var(--critical-bg)', text: 'var(--critical-text)', ring: 'var(--critical)' },
  good: { bg: 'var(--good-bg)', text: 'var(--good-text)', ring: 'var(--good)' },
  warning: { bg: 'var(--warning-bg)', text: 'var(--warning-text)', ring: 'var(--warning)' },
} as const

function Alert({ tone, children }: { tone: keyof typeof ALERT_TONE; children: React.ReactNode }) {
  const t = ALERT_TONE[tone]
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className="flex items-start gap-2 rounded-[var(--r-control)] border px-3 py-2.5 text-[length:var(--t-sm)] leading-relaxed"
      style={{ background: t.bg, color: t.text, borderColor: `color-mix(in oklab, ${t.ring} 32%, transparent)` }}
    >
      <span className="mt-px shrink-0">{tone === 'good' ? <CheckCircleIcon size={13} /> : <AlertIcon size={13} />}</span>
      <span>{children}</span>
    </div>
  )
}

/* ---------- the change summary ---------- */

interface Change {
  label: string
  from: string
  to: string
}

function ladderText(ladder: readonly LadderTier[]): string {
  return ladder.map((t) => `${t.hoursBefore}h→${t.retainPct}%`).join(', ')
}

/** What publishing would actually change, field by field. A version bump the merchant can't see the contents of is a version bump they can't be accountable for. */
function diffDraft(current: PolicyDraft | undefined, next: PolicyDraft): Change[] {
  if (!current) return []
  const changes: Change[] = []
  const push = (label: string, from: string | number, to: string | number) => {
    if (String(from) !== String(to)) changes.push({ label, from: String(from), to: String(to) })
  }
  push('Deposit', formatRupeesFixed(current.depositAmountPaise), formatRupeesFixed(next.depositAmountPaise))
  push('Cancellation ladder', ladderText(current.cancellationLadder), ladderText(next.cancellationLadder))
  push('Hold TTL', durationLabel(current.holdTtlSeconds), durationLabel(next.holdTtlSeconds))
  push('Max concurrent holds', current.maxConcurrentHoldsPerAgent, next.maxConcurrentHoldsPerAgent)
  push('Hold rate limit', `${current.holdRateLimitPerMinute}/min`, `${next.holdRateLimitPerMinute}/min`)
  return changes
}

/* ---------- sign-in ---------- */

function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="card mx-auto mt-6 max-w-[26rem] p-6">
      <div className="text-[length:var(--t-lg)] font-semibold tracking-[-0.01em] text-[var(--text)]">Merchant sign-in</div>
      <p className="mt-1.5 text-[length:var(--t-sm)] leading-relaxed text-[var(--text-muted)]">
        Publishing a policy needs the merchant API token. It&apos;s kept only in this browser tab&apos;s session storage — never sent anywhere but the merchant
        API, and never baked into this page.
      </p>
      <form
        className="mt-5 flex flex-col gap-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSubmit(value.trim())
        }}
      >
        <Field label="Merchant API token">
          <input type="password" className="control" placeholder="latch_mk_…" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
        <button type="submit" disabled={!value.trim()} className="btn btn-primary w-full">
          Continue
        </button>
      </form>
    </div>
  )
}

/* ---------- the editor ---------- */

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

  if (!token) return <TokenGate onSubmit={(t) => { sessionStorage.setItem(TOKEN_KEY, t); setToken(t) }} />

  if (loadState === 'loading' || loadState === 'idle') {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]" aria-busy="true" aria-label="Loading the active policy">
        <div className="flex flex-col gap-4">
          <div className="card h-[248px] animate-pulse" />
          <div className="card h-[168px] animate-pulse" />
        </div>
        <div className="card h-[224px] animate-pulse" />
      </div>
    )
  }

  if (loadState === 'error') {
    return <Alert tone="critical">Could not reach the merchant API: {loadError}</Alert>
  }

  if (!draft) return null

  const validationError = validateDraft(draft)
  const nextVersion = (policy?.policyVersion ?? 0) + 1
  const activeDraft = policy ? draftFromPolicy(policy) : undefined
  const changes = diffDraft(activeDraft, draft)
  const hasChanges = policy ? changes.length > 0 : true

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
      {/* ------- left: what the merchant is setting ------- */}
      <div className="flex flex-col gap-4">
        <Panel
          title="Deposit &amp; cancellation ladder"
          note="Taken up front when a booking is confirmed, and returned on the sliding scale below. A patient who never cancels and never attends is caught by the floor tier, which forfeits the deposit. A patient who does attend is charged the session-complete mandate instead."
        >
          <div className="grid gap-4 sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-end">
            <NumberField
              label="Deposit"
              suffix="paise"
              value={draft.depositAmountPaise}
              onChange={(n) => setDraft({ ...draft, depositAmountPaise: n })}
              hint={
                <span className="text-[length:var(--t-xs)] font-medium text-[var(--text)]">{formatRupeesFixed(draft.depositAmountPaise || 0)}</span>
              }
            />
            <p className="text-[length:var(--t-xs)] leading-relaxed text-[var(--text-muted)]">
              Every figure in the ladder is a share of this amount, so changing it re-prices every tier at once.
            </p>
          </div>

          <div className="mt-5 border-t border-[var(--border)] pt-4">
            <LadderEditor
              ladder={draft.cancellationLadder}
              depositPaise={draft.depositAmountPaise}
              onChange={(next) => setDraft({ ...draft, cancellationLadder: next })}
            />
          </div>
        </Panel>

        <Panel
          title="Agent limits"
          note="How much of the calendar a single agent can hold at once. These are the bounds an automated caller runs into before anything touches money."
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              label="Hold TTL"
              suffix="sec"
              value={draft.holdTtlSeconds}
              onChange={(n) => setDraft({ ...draft, holdTtlSeconds: n })}
              hint={`${durationLabel(draft.holdTtlSeconds)} · a slot returns to inventory after this`}
            />
            <NumberField
              label="Max concurrent holds"
              suffix="holds"
              value={draft.maxConcurrentHoldsPerAgent}
              onChange={(n) => setDraft({ ...draft, maxConcurrentHoldsPerAgent: n })}
              hint="per agent, at any one moment"
            />
            <NumberField
              label="Hold rate limit"
              suffix="/min"
              value={draft.holdRateLimitPerMinute}
              onChange={(n) => setDraft({ ...draft, holdRateLimitPerMinute: n })}
              hint="new holds per agent per minute"
            />
          </div>
        </Panel>

        <ServicesEditor token={token} depositAmountPaise={draft.depositAmountPaise} />
      </div>

      {/* ------- right: version, diff, publish ------- */}
      <aside className="flex flex-col gap-4 lg:sticky lg:top-[4.5rem]">
        <section className="card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[length:var(--t-2xs)] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">Active version</div>
              {policy ? (
                <div className="mt-1.5 flex items-baseline gap-2">
                  <span className="text-[length:var(--t-xl)] font-semibold tabular-nums text-[var(--text)]">v{policy.policyVersion}</span>
                  <span className="text-[length:var(--t-xs)] text-[var(--text-muted)]">cited by every new booking</span>
                </div>
              ) : (
                <div className="mt-1.5 text-[length:var(--t-sm)] font-medium text-[var(--warning-text)]">None published yet</div>
              )}
            </div>
            <button onClick={handleSignOut} className="btn btn-ghost px-2 py-1 text-[length:var(--t-xs)]">
              Sign out
            </button>
          </div>

          <div className="mt-4 border-t border-[var(--border)] pt-4">
            <div className="text-[length:var(--t-2xs)] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">Pending changes</div>

            {!hasChanges ? (
              <p className="mt-2 text-[length:var(--t-sm)] text-[var(--text-muted)]">The draft matches the active policy. Edit something on the left to publish a new version.</p>
            ) : changes.length === 0 ? (
              <p className="mt-2 text-[length:var(--t-sm)] text-[var(--text-muted)]">This will be the merchant&apos;s first published policy.</p>
            ) : (
              <ul className="mt-2.5 flex flex-col gap-2.5">
                {changes.map((c) => (
                  <li key={c.label}>
                    <div className="text-[length:var(--t-xs)] font-medium text-[var(--text)]">{c.label}</div>
                    <div className="mt-0.5 flex flex-wrap items-baseline gap-1.5 text-[length:var(--t-xs)]">
                      <span className="text-[var(--text-muted)] line-through">{c.from}</span>
                      <span className="text-[var(--text-muted)]" aria-hidden>
                        →
                      </span>
                      <span className="font-semibold text-[var(--text)]">{c.to}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-2.5 border-t border-[var(--border)] pt-4">
            {justPublished !== undefined && !hasChanges && (
              <Alert tone="good">
                Published v{justPublished}. Immutable from here — a booking confirmed under an older version keeps cancelling under that version, forever.
              </Alert>
            )}
            {validationError && <Alert tone="critical">{validationError}</Alert>}
            {publishError && <Alert tone="critical">{publishError}</Alert>}

            {!confirming ? (
              <button onClick={() => setConfirming(true)} disabled={!!validationError || !hasChanges} className="btn btn-primary w-full">
                Publish as v{nextVersion}
              </button>
            ) : (
              <div className="flex flex-col gap-2.5">
                <p className="text-[length:var(--t-xs)] leading-relaxed text-[var(--text-muted)]">
                  This appends v{nextVersion} — it does not edit v{policy?.policyVersion ?? '—'}. Bookings already confirmed keep cancelling under the version
                  they cited.
                </p>
                <button onClick={handlePublish} disabled={publishing} className="btn btn-danger w-full">
                  {publishing ? 'Publishing…' : `Confirm — publish v${nextVersion}`}
                </button>
                <button onClick={() => setConfirming(false)} disabled={publishing} className="btn btn-secondary w-full">
                  Cancel
                </button>
              </div>
            )}
          </div>
        </section>
      </aside>
    </div>
  )
}
