"use client"

import { GitBranch } from 'lucide-react'
import type { PipelineDonutData } from '@/lib/dashboard/types'
import { formatCurrencyShort } from '@/lib/currency'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface PipelineDonutProps {
  data: PipelineDonutData | null
  loading: boolean
  /** Account default currency for the totals. */
  currency: string
}

import { useTranslations } from 'next-intl'

export function PipelineDonut({ data, loading, currency }: PipelineDonutProps) {
  const t = useTranslations('Dashboard.pipelineDonut')
  return (
    <section className="flex h-full flex-col rounded-xl border border-border-strong bg-card shadow-sm">
      <header className="flex items-center gap-3 border-b border-border px-5 py-4">
        <span
          className="flex size-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary ring-1 ring-primary/20 ring-inset"
          aria-hidden
        >
          <GitBranch className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t('description')}
          </p>
        </div>
      </header>

      <div className="flex flex-1 flex-col p-5">
        {loading || !data ? (
          <Skeleton className="h-56 w-full" />
        ) : data.stages.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title={t('noOpenDeals')}
            hint={t('noOpenDealsHint')}
          />
        ) : (
          <>
            <Donut data={data} currency={currency} />
            {/* Rows carry their own surface and a colour bar rather than
                a loose dot: on a white card, a legend of muted text
                against nothing was the flattest block on the page. */}
            <ul className="mt-5 space-y-1.5">
              {data.stages.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-3 rounded-lg border border-transparent bg-muted/40 px-2.5 py-2 text-xs transition-colors hover:border-border hover:bg-muted"
                >
                  <span
                    className="h-6 w-1 flex-shrink-0 rounded-full"
                    style={{ background: s.color }}
                    aria-hidden
                  />
                  <span className="flex-1 truncate font-medium text-foreground">{s.name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {t('dealCount', { count: s.dealCount })}
                  </span>
                  <span className="w-20 text-right font-semibold text-foreground tabular-nums">
                    {formatCurrencyShort(s.totalValue, currency)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

// ------------------------------------------------------------
// SVG ring. 200×200 viewBox, 12px ring width. We draw one <path>
// per stage using an SVG arc from startAngle → endAngle. Gaps
// between segments are implied by a thin slate-900 stroke between
// them for a cleaner look.
// ------------------------------------------------------------
function Donut({ data, currency }: { data: PipelineDonutData; currency: string }) {
  const t = useTranslations('Dashboard.pipelineDonut')
  const size = 200
  const r = 80
  const ringWidth = 18
  const cx = size / 2
  const cy = size / 2

  // Small slices would render as slivers that disappear into stroke
  // rounding. We give each stage a floor share purely for rendering,
  // but keep the labels/legend honest with the actual totals.
  const totalRaw = data.totalValue || 1
  const minFrac = 0.02
  const rawShares = data.stages.map((s) => s.totalValue / totalRaw)
  const floored = rawShares.map((x) => Math.max(x, minFrac))
  const floorSum = floored.reduce((a, b) => a + b, 0)
  const shares = floored.map((x) => x / floorSum)

  // Build a cumulative-offset array, then map stages → arc paths. Using
  // a pre-computed offsets array avoids the Next 16 React Compiler's
  // "Cannot reassign variable after render completes" rule.
  const offsets: number[] = [0]
  for (let i = 0; i < shares.length; i++) offsets.push(offsets[i] + shares[i])

  // Separate the segments with a hairline gap so adjacent stages read
  // as distinct even when their colours are neighbours on the wheel.
  // The half-gap is clamped against the segment's own width, so a
  // sliver shrinks instead of inverting into a backwards arc.
  const GAP = data.stages.length > 1 ? 0.07 : 0
  const segments = data.stages.map((s, i) => {
    const start = offsets[i] * Math.PI * 2 - Math.PI / 2
    const end = offsets[i + 1] * Math.PI * 2 - Math.PI / 2
    const half = Math.min(GAP / 2, Math.max(0, (end - start - 0.02) / 2))
    return {
      path: arcPath(cx, cy, r, start + half, end - half),
      color: s.color,
      id: s.id,
    }
  })

  return (
    <div className="flex items-center justify-center">
      <svg viewBox={`0 0 ${size} ${size}`} className="h-48 w-48" role="img" aria-label={t('ariaLabel')}>
        {/* Track. --border rather than --muted: on a white card the
            muted token is all but invisible, and the ring is what
            tells you the donut is a whole with parts. */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={ringWidth} />
        {segments.map((seg) => (
          <path
            key={seg.id}
            d={seg.path}
            fill="none"
            stroke={seg.color}
            strokeWidth={ringWidth}
            strokeLinecap="butt"
          />
        ))}
        {/* center label */}
        <text
          x={cx}
          y={cy - 8}
          textAnchor="middle"
          className="fill-muted-foreground text-[10px] font-medium tracking-wide uppercase"
        >
          {t('total')}
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          className="fill-foreground text-[20px] font-bold tabular-nums"
        >
          {formatCurrencyShort(data.totalValue, currency)}
        </text>
      </svg>
    </div>
  )
}

function arcPath(cx: number, cy: number, r: number, startRad: number, endRad: number): string {
  const x1 = cx + r * Math.cos(startRad)
  const y1 = cy + r * Math.sin(startRad)
  const x2 = cx + r * Math.cos(endRad)
  const y2 = cy + r * Math.sin(endRad)
  const largeArc = endRad - startRad > Math.PI ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`
}
