import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

/**
 * Which hue the card wears. Decoration, not data: the tone is fixed
 * per metric and never reacts to the value, so a card never turns
 * alarming because of what it happens to be showing. The delta row
 * below is the only part that reads the number — that one *is* data.
 */
export type MetricTone = 'primary' | 'info' | 'success' | 'warn'

/**
 * Tone classes spelled out in full. Tailwind scans source for literal
 * class names, so a template like `bg-${tone}-soft` compiles to
 * nothing at all.
 */
const TONE: Record<
  MetricTone,
  { chip: string; ring: string; glow: string; rail: string; hoverBorder: string }
> = {
  primary: {
    chip: 'bg-primary-soft text-primary',
    ring: 'ring-primary/20',
    glow: 'bg-primary/25',
    rail: 'bg-primary',
    hoverBorder: 'hover:border-primary/40',
  },
  info: {
    chip: 'bg-info-soft text-info',
    ring: 'ring-info/20',
    glow: 'bg-info/25',
    rail: 'bg-info',
    hoverBorder: 'hover:border-info/40',
  },
  success: {
    chip: 'bg-success-soft text-success',
    ring: 'ring-success/20',
    glow: 'bg-success/25',
    rail: 'bg-success',
    hoverBorder: 'hover:border-success/40',
  },
  warn: {
    chip: 'bg-warn-soft text-warn',
    ring: 'ring-warn/20',
    glow: 'bg-warn/25',
    rail: 'bg-warn',
    hoverBorder: 'hover:border-warn/40',
  },
}

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /** Hue for the icon chip, top rail and corner wash. Defaults to the brand accent. */
  tone?: MetricTone
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
}

export function MetricCard({
  title,
  value,
  icon: Icon,
  tone = 'primary',
  delta,
  subtitle,
}: MetricCardProps) {
  const c = TONE[tone]
  return (
    <div
      className={cn(
        // `isolate` keeps the negative-z wash inside this card's own
        // stacking context: it paints over the card background but
        // stays behind the text, instead of sliding under the page.
        'group relative isolate flex flex-col overflow-hidden rounded-xl border border-border-strong bg-card p-5',
        'shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md',
        c.hoverBorder,
      )}
    >
      {/* Top rail — the cheapest way to give a row of cards an identity
          you can read at a glance without tinting the whole surface. */}
      <span
        className={cn(
          'absolute inset-x-0 top-0 h-[3px] opacity-80 transition-opacity duration-200 group-hover:opacity-100',
          c.rail,
        )}
        aria-hidden
      />
      {/* Corner wash. Blurred well past its own box so it reads as
          light falling on the card rather than a shape drawn on it. */}
      <span
        className={cn(
          'pointer-events-none absolute -top-14 -right-12 -z-10 size-36 rounded-full opacity-50 blur-3xl transition-opacity duration-300 group-hover:opacity-80',
          c.glow,
        )}
        aria-hidden
      />

      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div
          className={cn(
            'flex size-9 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-inset transition-transform duration-200 group-hover:scale-105',
            c.chip,
            c.ring,
          )}
          aria-hidden
        >
          <Icon className="size-4.5" />
        </div>
      </div>

      <p className="mt-3 text-[32px] leading-none font-bold tracking-tight text-foreground tabular-nums">
        {value}
      </p>

      {/* mt-auto pins the footer to the bottom so the secondary rows
          line up across a grid whose titles wrap to different heights. */}
      <div className="mt-auto pt-3">
        {delta ? (
          <DeltaRow sign={delta.sign} label={delta.label} />
        ) : subtitle ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="size-1.5 flex-shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
            <span className="truncate">{subtitle}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  // Fixed green/red rather than the accent: direction has to keep
  // meaning when someone switches the app to the rose or amber theme.
  const badge =
    sign > 0
      ? 'bg-success-soft text-success'
      : sign < 0
        ? 'bg-danger-soft text-danger'
        : 'bg-muted text-muted-foreground'
  const text =
    sign > 0 ? 'text-success' : sign < 0 ? 'text-danger' : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={cn(
          'flex size-5 flex-shrink-0 items-center justify-center rounded-full',
          badge,
        )}
        aria-hidden
      >
        <Arrow className="size-3" strokeWidth={2.75} />
      </span>
      <span className={cn('truncate font-medium tabular-nums', text)}>{label}</span>
    </div>
  )
}
