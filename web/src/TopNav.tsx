import { useState } from 'react'

export type Section = 'audits' | 'policy'

function LedgerIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  )
}
function InstitutionIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10 12 4l9 6" />
      <path d="M5 10v9M10 10v9M14 10v9M19 10v9" />
      <path d="M3 21h18" />
    </svg>
  )
}
function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}
function PulseIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l2 8 4-16 2 8h6" />
    </svg>
  )
}
function BellIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  )
}
function GridIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

const NAV_ITEMS: { key: Section; label: string; icon: (active: boolean) => React.ReactNode }[] = [
  { key: 'audits', label: 'Audits', icon: (a) => <LedgerIcon active={a} /> },
  { key: 'policy', label: 'Policy', icon: (a) => <InstitutionIcon active={a} /> },
]

/**
 * Pixel-reference: Razorpay's own dashboard top bar (black, house icon +
 * "Razorpay Home" then nav items, search + icon cluster + avatar on the
 * right, the active item marked with a soft blue glow chip). Reduced here
 * to Latch's own two sections. This is our own admin surface adopting a
 * familiar dashboard chrome, not a claim to be Razorpay's product — labeled
 * "Latch" throughout.
 */
export function TopNav({
  section,
  onSection,
  liveCount,
  refusalCount,
  onSearch,
}: {
  section: Section
  onSection: (s: Section) => void
  liveCount: number
  refusalCount: number
  onSearch: (query: string) => void
}) {
  const [query, setQuery] = useState('')

  return (
    <nav className="flex items-center gap-8 bg-[#0a0a0d] px-6 py-3">
      <div className="flex items-center gap-1.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-[6px] bg-white font-mono text-[12px] font-bold text-[#0a0a0d]">L</span>
        <span className="text-[15px] font-semibold text-white">Latch Home</span>
      </div>

      <div className="flex items-center gap-1">
        {NAV_ITEMS.map((item) => {
          const active = section === item.key
          return (
            <button
              key={item.key}
              onClick={() => onSection(item.key)}
              className={`relative flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] font-medium transition ${
                active ? 'text-white' : 'text-[#9a9aa8] hover:text-white'
              }`}
              style={active ? { boxShadow: '0 0 0 1px rgba(59,130,246,0.4), 0 0 22px 2px rgba(59,130,246,0.45)', background: 'rgba(59,130,246,0.12)' } : undefined}
            >
              {item.icon(active)}
              {item.label}
              {item.key === 'audits' && refusalCount > 0 && (
                <span className="ml-0.5 rounded-full bg-[var(--critical)] px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">{refusalCount}</span>
              )}
            </button>
          )
        })}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-2 rounded-lg bg-[#1c1c22] px-3 py-2">
          <span className="text-[#7a7a88]">
            <SearchIcon />
          </span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              onSearch(e.target.value)
            }}
            placeholder="Search bookings, events, and more"
            className="w-64 bg-transparent text-[13px] text-white outline-none placeholder:text-[#7a7a88]"
          />
        </div>

        <button
          title={`Connection: ${liveCount} events streamed`}
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1c1c22] text-[#c9c9d4] transition hover:bg-[#2a2a32] hover:text-white"
        >
          <PulseIcon />
        </button>
        <button
          title={refusalCount > 0 ? `${refusalCount} refusal${refusalCount === 1 ? '' : 's'} recorded` : 'No refusals recorded'}
          className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-[#1c1c22] text-[#c9c9d4] transition hover:bg-[#2a2a32] hover:text-white"
        >
          <BellIcon />
          {refusalCount > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--critical)]" />}
        </button>
        <button title="Latch — Slice 6" className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1c1c22] text-[#c9c9d4] transition hover:bg-[#2a2a32] hover:text-white">
          <GridIcon />
        </button>

        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1d2a5c] text-[12px] font-bold text-white" title="Merchant: Dr. Rao's Clinic">
          DR
        </span>
      </div>
    </nav>
  )
}
