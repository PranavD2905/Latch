import { LatchMark } from './LatchMark'
import type { ConnectionState } from './useEventStream'

export type Section = 'audits' | 'policy'

const CONNECTION: Record<ConnectionState, { text: string; dot: string; live: boolean }> = {
  connecting: { text: 'CONNECTING', dot: 'var(--on-topbar-muted)', live: false },
  open: { text: 'LIVE', dot: 'oklch(0.72 0.17 150)', live: true },
  reconnecting: { text: 'RECONNECTING', dot: 'oklch(0.80 0.15 82)', live: false },
}

/**
 * The top bar carries the brand and nothing else — every destination lives in
 * the left rail.
 *
 * The tab hanging below its centre is where the Razorpay dashboard puts its
 * test/live mode switch. The equivalent fact here is whether the SSE feed is
 * actually attached, so that is what hangs there. It is shown from `lg` up,
 * where the rail is visible and the space below the bar is empty; smaller
 * viewports get the same state as a chip on the right, because the compact
 * nav strip occupies the space the tab would hang into.
 */
export function TopBar({ connection, eventCount }: { connection: ConnectionState; eventCount: number }) {
  const conn = CONNECTION[connection]

  return (
    <header className="on-dark sticky top-0 z-[var(--z-sticky)] h-[var(--topbar-h)] bg-[var(--topbar)]">
      <div className="relative flex h-full items-center px-4">
        <div className="flex shrink-0 items-center gap-2 text-[var(--on-topbar)]">
          <LatchMark size={19} />
          <span className="text-[length:var(--t-md)] font-semibold tracking-[-0.015em]">Latch</span>
        </div>

        <span
          className="ml-auto flex items-center gap-2 rounded-full bg-[var(--topbar-raised)] px-2.5 py-1 lg:hidden"
          title={`${conn.text.toLowerCase()} · ${eventCount} events`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${conn.live ? 'live-pulse' : ''}`} style={{ background: conn.dot }} />
          <span className="text-[length:var(--t-xs)] font-medium text-[var(--on-topbar-muted)]">{conn.text}</span>
        </span>

        <div className="pointer-events-none absolute left-1/2 top-full hidden -translate-x-1/2 lg:block">
          <div className="flex items-center gap-2.5 rounded-b-[10px] bg-[var(--topbar)] px-4 py-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${conn.live ? 'live-pulse' : ''}`} style={{ background: conn.dot }} />
            <span className="text-[length:var(--t-xs)] font-semibold tracking-[0.14em] text-[var(--on-topbar)]">{conn.text}</span>
            <span className="h-3 w-px bg-[var(--topbar-line)]" />
            <span className="text-[length:var(--t-xs)] tabular-nums text-[var(--on-topbar-muted)]">{eventCount.toLocaleString('en-IN')} events</span>
          </div>
        </div>
      </div>
    </header>
  )
}
