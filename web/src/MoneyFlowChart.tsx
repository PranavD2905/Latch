import { useMemo, useRef, useState } from 'react'
import type { RunningPoint } from './totals'
import { formatRupees } from './types'

const WIDTH = 900
const HEIGHT = 240
const PAD_L = 62
const PAD_R = 8
const PAD_T = 28
const PAD_B = 28

function niceMax(value: number): number {
  if (value <= 0) return 100
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

/**
 * Cumulative net customer cost vs. net merchant retention, one point per
 * event — the demo's central claim rendered as a picture: the cost line
 * rising with the deposit and falling back to the baseline on a refund.
 * dataviz skill: one shared y-axis (rupees) for both series — never a
 * dual-axis chart. x is event order, not `occurredAt` — the same reason
 * `listAllEvents` orders by `global_sequence` rather than a domain
 * timestamp (dev-logs/011): a frozen-clock test event can carry a
 * timestamp far from its real position in the trail.
 */
export function MoneyFlowChart({ series }: { series: readonly RunningPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const { costPoints, retentionPoints, yMax, xScale, yScale } = useMemo(() => {
    const n = series.length
    const maxVal = Math.max(1, ...series.map((p) => Math.max(p.netCustomerCostPaise, p.netMerchantRetentionPaise)))
    const yMax = niceMax(maxVal / 100)
    const innerW = WIDTH - PAD_L - PAD_R
    const innerH = HEIGHT - PAD_T - PAD_B
    const xScale = (i: number) => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
    const yScale = (rupees: number) => PAD_T + innerH - (rupees / yMax) * innerH
    const costPoints = series.map((p, i) => [xScale(i), yScale(p.netCustomerCostPaise / 100)] as const)
    const retentionPoints = series.map((p, i) => [xScale(i), yScale(p.netMerchantRetentionPaise / 100)] as const)
    return { costPoints, retentionPoints, yMax, xScale, yScale }
  }, [series])

  if (series.length === 0) {
    return (
      <div className="flex h-[240px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--border-strong)] text-center">
        <span className="text-[length:var(--t-sm)] font-medium text-[var(--text-muted)]">Nothing to plot yet</span>
        <span className="max-w-[42ch] text-[length:var(--t-xs)] text-[var(--text-muted)]">Both lines start at ₹0 and move on the first money event that lands.</span>
      </div>
    )
  }

  const linePath = (points: readonly (readonly [number, number])[]) => points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ')
  const areaPath = (points: readonly (readonly [number, number])[]) => {
    const baseline = yScale(0)
    return `${linePath(points)} L ${points[points.length - 1]![0]} ${baseline} L ${points[0]![0]} ${baseline} Z`
  }

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((t) => PAD_T + (HEIGHT - PAD_T - PAD_B) * t)

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * WIDTH
    const n = series.length
    const idx = n <= 1 ? 0 : Math.round(((relX - PAD_L) / (WIDTH - PAD_L - PAD_R)) * (n - 1))
    setHoverIndex(Math.max(0, Math.min(n - 1, idx)))
  }

  const hovered = hoverIndex !== null ? series[hoverIndex] : undefined
  const last = series[series.length - 1]!

  return (
    <div>
      {/* legend — a line-key + label per series, required at 2+ series */}
      <div className="mb-3 flex items-center gap-5 text-[length:var(--t-xs)] text-[var(--text-secondary)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4 rounded" style={{ background: 'var(--series-cost)' }} />
          net customer cost
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4 rounded" style={{ background: 'var(--series-retention)' }} />
          net merchant retention
        </span>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full touch-none"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {gridLines.map((y, i) => (
            <line key={i} x1={PAD_L} x2={WIDTH - PAD_R} y1={y} y2={y} stroke="var(--chart-grid)" strokeWidth={1} />
          ))}
          {/* y-axis tick labels */}
          {/* labels live in a left gutter rather than on top of the plot */}
          {[0, 0.5, 1].map((t) => (
            <text
              key={t}
              x={PAD_L - 10}
              y={PAD_T + (HEIGHT - PAD_T - PAD_B) * (1 - t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--chart-muted)"
            >
              ₹{Math.round(yMax * t).toLocaleString('en-IN')}
            </text>
          ))}

          <path d={areaPath(retentionPoints)} fill="var(--series-retention)" opacity={0.1} />
          <path d={areaPath(costPoints)} fill="var(--series-cost)" opacity={0.1} />

          <path d={linePath(retentionPoints)} fill="none" stroke="var(--series-retention)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={linePath(costPoints)} fill="none" stroke="var(--series-cost)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {/* end markers + direct labels — mark spec: r>=4, 2px surface ring */}
          <circle cx={costPoints[costPoints.length - 1]![0]} cy={costPoints[costPoints.length - 1]![1]} r={4} fill="var(--series-cost)" stroke="var(--surface)" strokeWidth={2} />
          <circle
            cx={retentionPoints[retentionPoints.length - 1]![0]}
            cy={retentionPoints[retentionPoints.length - 1]![1]}
            r={4}
            fill="var(--series-retention)"
            stroke="var(--surface)"
            strokeWidth={2}
          />
          <text
            x={costPoints[costPoints.length - 1]![0] - 4}
            y={costPoints[costPoints.length - 1]![1] - 8}
            textAnchor="end"
            className="font-semibold"
            fontSize={11}
            fill="var(--text)"
          >
            {formatRupees(last.netCustomerCostPaise)}
          </text>
          <text
            x={retentionPoints[retentionPoints.length - 1]![0] - 4}
            y={retentionPoints[retentionPoints.length - 1]![1] + 16}
            textAnchor="end"
            className="font-semibold"
            fontSize={11}
            fill="var(--text)"
          >
            {formatRupees(last.netMerchantRetentionPaise)}
          </text>

          {hovered && (
            <>
              <line x1={xScale(hoverIndex!)} x2={xScale(hoverIndex!)} y1={PAD_T} y2={HEIGHT - PAD_B} stroke="var(--chart-baseline)" strokeWidth={1} />
              <circle cx={xScale(hoverIndex!)} cy={yScale(hovered.netCustomerCostPaise / 100)} r={4} fill="var(--series-cost)" stroke="var(--surface)" strokeWidth={2} />
              <circle
                cx={xScale(hoverIndex!)}
                cy={yScale(hovered.netMerchantRetentionPaise / 100)}
                r={4}
                fill="var(--series-retention)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
            </>
          )}
        </svg>

        {hovered && (
          <div
            className="pointer-events-none absolute top-1 z-[var(--z-tooltip)] min-w-[190px] rounded-lg bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-pop)] ring-1 ring-[var(--border)]"
            style={{ left: `${(xScale(hoverIndex!) / WIDTH) * 100}%`, transform: hoverIndex! > series.length / 2 ? 'translateX(-105%)' : 'translateX(6%)' }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">{hovered.event.type}</div>
            <div className="mt-1 flex items-center justify-between gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-[var(--text-muted)]">
                <span className="inline-block h-[2px] w-3 rounded" style={{ background: 'var(--series-cost)' }} />
                cost
              </span>
              <span className="font-semibold text-[var(--text)]">{formatRupees(hovered.netCustomerCostPaise)}</span>
            </div>
            <div className="flex items-center justify-between gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-[var(--text-muted)]">
                <span className="inline-block h-[2px] w-3 rounded" style={{ background: 'var(--series-retention)' }} />
                retention
              </span>
              <span className="font-semibold text-[var(--text)]">{formatRupees(hovered.netMerchantRetentionPaise)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
