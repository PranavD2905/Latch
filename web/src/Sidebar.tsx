import { CalendarIcon, ListIcon, SlidersIcon } from './icons'

export type View = 'events' | 'bookings' | 'policy'

interface NavItem {
  key: View
  label: string
  icon: React.ReactNode
  badge?: number
}

interface NavGroup {
  label?: string
  items: NavItem[]
}

/**
 * Left rail — the app's only navigation. Two groups, three real destinations;
 * the refusal count rides on Events because that is the view that shows them.
 */
function groups(refusalCount: number): NavGroup[] {
  return [
    {
      label: 'Audit trail',
      items: [
        { key: 'events', label: 'Events', icon: <ListIcon size={16} />, badge: refusalCount },
        { key: 'bookings', label: 'Bookings', icon: <CalendarIcon size={16} /> },
      ],
    },
    {
      label: 'Merchant',
      items: [{ key: 'policy', label: 'Policy', icon: <SlidersIcon size={16} /> }],
    },
  ]
}

/**
 * Below `lg` the rail is hidden, which would otherwise strand the reader on
 * whatever view loaded first — so the same destinations reappear as a
 * scrollable strip under the top bar.
 */
export function CompactNav({ view, onView, refusalCount }: { view: View; onView: (v: View) => void; refusalCount: number }) {
  const items = groups(refusalCount).flatMap((g) => g.items)
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 lg:hidden" aria-label="Views">
      {items.map((item) => {
        const active = view === item.key
        return (
          <button
            key={item.key}
            onClick={() => onView(item.key)}
            aria-current={active ? 'page' : undefined}
            className={`flex shrink-0 items-center gap-1.5 rounded-[var(--r-control)] px-2.5 py-1.5 text-[length:var(--t-sm)] transition-colors duration-[var(--dur)] ${
              active ? 'bg-[var(--neutral-bg)] font-semibold text-[var(--text)]' : 'font-medium text-[var(--text-secondary)]'
            }`}
          >
            {item.icon}
            {item.label}
            {item.badge !== undefined && item.badge > 0 && (
              <span className="rounded-full bg-[var(--critical-bg)] px-1.5 py-px text-[length:var(--t-2xs)] font-semibold tabular-nums text-[var(--critical-text)]">
                {item.badge > 999 ? '999+' : item.badge}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}

export function Sidebar({
  view,
  onView,
  refusalCount,
  trailWindow,
}: {
  view: View
  onView: (v: View) => void
  refusalCount: number
  trailWindow: string
}) {
  return (
    <aside className="hidden w-[var(--sidebar-w)] shrink-0 border-r border-[var(--border)] bg-[var(--surface)] lg:block">
      <div className="sticky top-[var(--topbar-h)] flex h-[calc(100vh-var(--topbar-h))] flex-col">
        <nav className="flex-1 overflow-y-auto py-3" aria-label="Views">
          {groups(refusalCount).map((group, gi) => (
            <div key={group.label ?? gi} className={gi > 0 ? 'mt-5' : undefined}>
              {group.label && (
                <div className="px-5 pb-2 text-[length:var(--t-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--text-muted)]">{group.label}</div>
              )}
              {group.items.map((item) => {
                const active = view === item.key
                return (
                  <button
                    key={item.key}
                    onClick={() => onView(item.key)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex w-full items-center gap-3 px-5 py-2.5 text-left text-[length:var(--t-base)] transition-colors duration-[var(--dur)] ${
                      active
                        ? 'bg-[var(--neutral-bg)] font-semibold text-[var(--text)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                    }`}
                  >
                    <span className={active ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}>{item.icon}</span>
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge !== undefined && item.badge > 0 && (
                      <span className="rounded-full bg-[var(--critical-bg)] px-1.5 py-px text-[length:var(--t-2xs)] font-semibold tabular-nums text-[var(--critical-text)]">
                        {item.badge > 999 ? '999+' : item.badge}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="border-t border-[var(--border)] px-5 py-3.5">
          <div className="text-[length:var(--t-sm)] font-medium text-[var(--text)]">Dr. Rao&apos;s Clinic</div>
          <div className="mt-0.5 text-[length:var(--t-xs)] leading-relaxed text-[var(--text-muted)]">{trailWindow}</div>
        </div>
      </div>
    </aside>
  )
}
