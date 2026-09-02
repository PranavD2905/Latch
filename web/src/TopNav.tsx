import { LatchMark } from './LatchMark'
import type { ConnectionState } from './useEventStream'

export type Section = 'audits' | 'policy'

function LedgerIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.1 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  )
}
function InstitutionIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.1 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 10 12 4l9 6" />
      <path d="M5 10v9M10 10v9M14 10v9M19 10v9" />
      <path d="M3 21h18" />
    </svg>
  )
}

const NAV_ITEMS: { key: Section; label: string; icon: (active: boolean) => React.ReactNode }[] = [
  { key: 'audits', label: 'Audit trail', icon: (a) => <LedgerIcon active={a} /> },
  { key: 'policy', label: 'Policy', icon: (a) => <InstitutionIcon active={a} /> },
]

const CONNECTION: Record<ConnectionState, { text: string; color: string; live: boolean }> = {
  connecting: { text: 'Connecting', color: 'var(--on-ink-faint)', live: false },
  open: { text: 'Live', color: 'var(--good-on-ink)', live: true },
  reconnecting: { text: 'Reconnecting', color: 'var(--warning-on-ink)', live: false },
}

/**
 * The shell's only chrome. The connection state lives here rather than in a
 * floating pill over the content: it's a property of the whole session, and
 * a fixed button parked over the bottom-right of an audit table is a thing
 * to dismiss, not a thing to read.
 */
export function TopNav({
  section,
  onSection,
  refusalCount,
  connection,
  eventCount,
}: {
  section: Section
  onSection: (s: Section) => void
  refusalCount: number
  connection: ConnectionState
  eventCount: number
}) {
  const conn = CONNECTION[connection]

  return (
    <nav className="on-ink sticky top-0 z-[var(--z-sticky)] flex items-center gap-6 border-b border-[var(--ink-line-soft)] bg-[var(--ink)]/95 px-5 py-2.5 backdrop-blur-sm sm:px-7">
      <div className="flex shrink-0 items-center gap-2 text-[var(--on-ink)]">
        <LatchMark size={20} />
        <span className="hidden text-[length:var(--t-md)] font-semibold tracking-[-0.015em] sm:inline">Latch</span>
      </div>

      <div role="tablist" aria-label="Sections" className="flex items-center gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active = section === item.key
          return (
            <button
              key={item.key}
              role="tab"
              aria-selected={active}
              onClick={() => onSection(item.key)}
              className={`relative flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[length:var(--t-sm)] font-medium transition-colors duration-[var(--dur)] ${
                active
                  ? 'bg-[var(--ink-raised)] text-[var(--on-ink)] shadow-[inset_0_0_0_1px_var(--ink-line)]'
                  : 'text-[var(--on-ink-muted)] hover:bg-[var(--ink-line-soft)] hover:text-[var(--on-ink)]'
              }`}
            >
              {item.icon(active)}
              <span className="hidden sm:inline">{item.label}</span>
              {item.key === 'audits' && refusalCount > 0 && (
                <span
                  className="rounded-full px-1.5 py-px font-mono text-[10px] font-bold leading-[1.4] text-[var(--ink)]"
                  style={{ background: 'var(--critical-on-ink)' }}
                  title={`${refusalCount} refused action${refusalCount === 1 ? '' : 's'} in the trail`}
                >
                  {refusalCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="ml-auto flex items-center gap-3 sm:gap-4">
        <div className="flex items-center gap-2 rounded-full border border-[var(--ink-line)] px-2.5 py-1" title="Server-sent events connection to the audit trail">
          <span
            className={`h-1.5 w-1.5 rounded-full ${conn.live ? 'live-pulse' : ''}`}
            style={{ background: conn.color, ['--pulse-color' as string]: conn.color }}
          />
          <span className="text-[length:var(--t-xs)] font-medium text-[var(--on-ink-muted)]">{conn.text}</span>
          <span className="hidden font-mono text-[length:var(--t-xs)] tabular-nums text-[var(--on-ink-faint)] sm:inline">· {eventCount}</span>
        </div>

        <span
          className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ink-raised)] font-mono text-[11px] font-bold text-[var(--on-ink-muted)] shadow-[inset_0_0_0_1px_var(--ink-line)]"
          title="Merchant: Dr. Rao's Clinic"
        >
          DR
        </span>
      </div>
    </nav>
  )
}
