'use client'

import { formatCurrencyExact, formatCurrencyShort } from '@/lib/currency'

// ------------------------------------------------------------
// Presentational chart primitives for the sales dashboard.
//
// Hand-rolled SVG/CSS rather than a chart library, matching the rest of
// `components/dashboard`: these shapes are simple, and drawing them
// directly keeps them on the app's theme tokens (so they follow light
// and dark mode) instead of a library's own colour handling.
// ------------------------------------------------------------

/**
 * Series palette for categories that carry no colour of their own
 * (products, sellers). Assigned by index, so a category keeps its
 * colour as long as the ordering holds. Chosen to stay legible on both
 * the light and the dark surface.
 */
export const SERIES_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#f97316',
  '#84cc16',
  '#a855f7',
  '#14b8a6',
] as const

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]
}

export interface ChartSlice {
  id: string
  name: string
  color?: string
  count: number
  value: number
  units?: number
}

// ============================================================
// Donut
// ============================================================

interface DonutProps {
  slices: ChartSlice[]
  currency: string
  /** Text under the centre figure. */
  centerLabel: string
  ariaLabel: string
}

export function SalesDonut({ slices, currency, centerLabel, ariaLabel }: DonutProps) {
  const size = 200
  const r = 80
  const ringWidth = 18
  const cx = size / 2
  const cy = size / 2

  const total = slices.reduce((s, x) => s + Math.abs(x.value), 0)

  // A slice worth a fraction of a percent still has to be visible, so
  // every one gets a rendering floor. The legend keeps the real
  // numbers — the ring is a shape, the list is the record.
  const denominator = total || 1
  const minFrac = 0.02
  const floored = slices.map((s) => Math.max(Math.abs(s.value) / denominator, minFrac))
  const floorSum = floored.reduce((a, b) => a + b, 0) || 1
  const shares = floored.map((x) => x / floorSum)

  // Cumulative offsets built up front: reassigning an accumulator
  // across the render body trips the React Compiler rule the pipeline
  // donut already ran into.
  const offsets: number[] = [0]
  for (let i = 0; i < shares.length; i++) offsets.push(offsets[i] + shares[i])

  return (
    <div className="flex items-center justify-center">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-48 w-48"
        role="img"
        aria-label={ariaLabel}
      >
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={ringWidth}
        />
        {slices.map((slice, i) => {
          const start = offsets[i] * Math.PI * 2 - Math.PI / 2
          const end = offsets[i + 1] * Math.PI * 2 - Math.PI / 2
          return (
            <path
              key={slice.id}
              d={arcPath(cx, cy, r, start, end)}
              fill="none"
              stroke={slice.color ?? seriesColor(i)}
              strokeWidth={ringWidth}
              strokeLinecap="butt"
            />
          )
        })}
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          className="fill-foreground text-[18px] font-semibold tabular-nums"
        >
          {formatCurrencyShort(total, currency)}
        </text>
        <text
          x={cx}
          y={cy - 6}
          textAnchor="middle"
          className="fill-muted-foreground text-[11px]"
        >
          {centerLabel}
        </text>
      </svg>
    </div>
  )
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startRad: number,
  endRad: number,
): string {
  const x1 = cx + r * Math.cos(startRad)
  const y1 = cy + r * Math.sin(startRad)
  const x2 = cx + r * Math.cos(endRad)
  const y2 = cy + r * Math.sin(endRad)
  const largeArc = endRad - startRad > Math.PI ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`
}

// ============================================================
// Goal gauge
// ============================================================

interface GaugeProps {
  /** 0–1+ fraction of the target reached. */
  attainment: number
  label: string
  ariaLabel: string
}

/**
 * Three-quarter ring showing target attainment. Over-attainment is
 * clamped for drawing (a full ring) but shown in full in the label —
 * 140% is worth celebrating, not wrapping around to 40%.
 */
export function GoalGauge({ attainment, label, ariaLabel }: GaugeProps) {
  const size = 180
  const r = 70
  const ringWidth = 16
  const cx = size / 2
  const cy = size / 2

  // Sweep 270°, starting at the lower-left (135°) and ending at the
  // lower-right, leaving the familiar dial gap at the bottom.
  const startRad = (135 * Math.PI) / 180
  const sweep = (270 * Math.PI) / 180
  const drawn = Math.max(0, Math.min(attainment, 1))

  const pct = Math.round(attainment * 100)

  return (
    <div className="flex items-center justify-center">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-44 w-44"
        role="img"
        aria-label={ariaLabel}
      >
        <path
          d={arcPath(cx, cy, r, startRad, startRad + sweep)}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={ringWidth}
          strokeLinecap="round"
        />
        {drawn > 0 && (
          <path
            d={arcPath(cx, cy, r, startRad, startRad + sweep * drawn)}
            fill="none"
            stroke={attainment >= 1 ? '#10b981' : '#3b82f6'}
            strokeWidth={ringWidth}
            strokeLinecap="round"
          />
        )}
        <text
          x={cx}
          y={cy + 4}
          textAnchor="middle"
          className="fill-foreground text-[26px] font-bold tabular-nums"
        >
          {pct}%
        </text>
        <text
          x={cx}
          y={cy + 24}
          textAnchor="middle"
          className="fill-muted-foreground text-[11px]"
        >
          {label}
        </text>
      </svg>
    </div>
  )
}

// ============================================================
// Horizontal bar list
// ============================================================

interface BarListProps {
  items: ChartSlice[]
  currency: string
  /** Rendered when `items` is empty. */
  emptyLabel: string
  /** `count` unit, e.g. "3 negócios". Receives the raw count. */
  countLabel?: (count: number) => string
}

/**
 * Ranked rows with a proportional fill — the shape the reference
 * dashboard uses for "Origem do lead", "Aberto por etapas" and
 * "Aberto por vendedor". Percentages are of the column total, so they
 * sum to 100 and answer "how much of this came from here".
 */
export function BarList({ items, currency, emptyLabel, countLabel }: BarListProps) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">{emptyLabel}</p>
    )
  }

  const total = items.reduce((s, x) => s + Math.abs(x.value), 0)
  const max = items.reduce((m, x) => Math.max(m, Math.abs(x.value)), 0) || 1

  return (
    <ul className="space-y-2.5">
      {items.map((item, i) => {
        const share = total > 0 ? Math.abs(item.value) / total : 0
        const color = item.color ?? seriesColor(i)
        return (
          <li key={item.id}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-foreground">
                {item.name}
              </span>
              {countLabel && (
                <span className="tabular-nums text-muted-foreground">
                  {countLabel(item.count)}
                </span>
              )}
              <span className="tabular-nums text-muted-foreground">
                {formatCurrencyExact(item.value, currency)}
              </span>
              <span className="w-12 text-right tabular-nums text-muted-foreground">
                {(share * 100).toFixed(1)}%
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(Math.abs(item.value) / max) * 100}%`,
                  background: color,
                }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ============================================================
// Vertical column chart (seller ranking)
// ============================================================

interface ColumnChartProps {
  items: ChartSlice[]
  currency: string
  emptyLabel: string
}

/**
 * Ranking columns. Heights are relative to the tallest bar rather than
 * to the total, because the question this chart answers is "who is
 * ahead, and by how much" — a share-of-total scale would flatten
 * everyone once there are more than a handful of sellers.
 */
export function ColumnChart({ items, currency, emptyLabel }: ColumnChartProps) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">{emptyLabel}</p>
    )
  }

  const max = items.reduce((m, x) => Math.max(m, Math.abs(x.value)), 0) || 1
  const total = items.reduce((s, x) => s + Math.abs(x.value), 0)

  return (
    <div className="flex h-56 items-end justify-around gap-3 overflow-x-auto px-1">
      {items.map((item, i) => {
        const heightPct = (Math.abs(item.value) / max) * 100
        const share = total > 0 ? (Math.abs(item.value) / total) * 100 : 0
        return (
          <div
            key={item.id}
            className="flex h-full min-w-[64px] flex-1 flex-col items-center justify-end gap-1.5"
          >
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {formatCurrencyShort(item.value, currency)}
              {' · '}
              {share.toFixed(1)}%
            </span>
            <div
              className="w-full max-w-[72px] rounded-t-md transition-all"
              // A zero-value bar still gets 2px so the column, and its
              // label, stay findable on the axis.
              style={{
                height: `max(2px, ${heightPct}%)`,
                background: item.color ?? seriesColor(i),
              }}
              title={formatCurrencyExact(item.value, currency)}
            />
            <span className="w-full truncate text-center text-[11px] text-muted-foreground">
              {item.name}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ============================================================
// Legend row used beside the product donut
// ============================================================

export function DonutLegend({
  slices,
  currency,
  unitsLabel,
}: {
  slices: ChartSlice[]
  currency: string
  unitsLabel: (units: number) => string
}) {
  return (
    <ul className="mt-5 space-y-2">
      {slices.map((slice, i) => (
        <li key={slice.id} className="flex items-center gap-3 text-xs">
          <span
            className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
            style={{ background: slice.color ?? seriesColor(i) }}
            aria-hidden
          />
          <span className="flex-1 truncate text-muted-foreground">{slice.name}</span>
          {slice.units != null && slice.units > 0 && (
            <span className="tabular-nums text-muted-foreground">
              {unitsLabel(slice.units)}
            </span>
          )}
          <span className="w-20 text-right tabular-nums text-muted-foreground">
            {formatCurrencyShort(slice.value, currency)}
          </span>
        </li>
      ))}
    </ul>
  )
}
