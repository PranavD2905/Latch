import type { RunningTotals } from './totals'
import { formatRupees } from './types'
import type { ConnectionState } from './useEventStream'

function Stat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className={`font-mono text-xl font-bold tabular-nums ${emphasize ? 'text-emerald-300' : 'text-slate-100'}`}>
        {value}
      </span>
    </div>
  )
}

const CONNECTION_LABEL: Record<ConnectionState, { text: string; className: string }> = {
  connecting: { text: 'CONNECTING', className: 'bg-slate-500' },
  open: { text: 'LIVE', className: 'bg-emerald-400' },
  reconnecting: { text: 'RECONNECTING', className: 'bg-amber-400' },
}

export function TotalsBar({ totals, connection }: { totals: RunningTotals; connection: ConnectionState }) {
  const { text, className } = CONNECTION_LABEL[connection]
  const customerCostIsZero = totals.netCustomerCostPaise === 0

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-6 border-b border-slate-800 bg-[#0a0a0c]/95 px-5 py-4 backdrop-blur">
      <div className="flex flex-wrap gap-8">
        <Stat label="net customer cost" value={formatRupees(totals.netCustomerCostPaise)} emphasize={customerCostIsZero} />
        <Stat label="net merchant retention" value={formatRupees(totals.netMerchantRetentionPaise)} />
        <Stat label="authorisation headroom remaining" value={formatRupees(totals.authorizationHeadroomPaise)} />
      </div>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${className} ${connection === 'open' ? 'animate-pulse' : ''}`} />
        <span className="font-mono text-[11px] tracking-wider text-slate-400">{text}</span>
      </div>
    </div>
  )
}
