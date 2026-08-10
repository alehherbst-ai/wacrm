'use client'

import type { ComponentType } from 'react'

/**
 * Solid-colour KPI tile for the sales dashboard.
 *
 * Separate from `MetricCard` on purpose: the overview tab keeps the
 * neutral card surface, and a shared component with a `tone` prop
 * would have made every dashboard in the app inherit this treatment
 * the first time someone passed the wrong default.
 *
 * Colour is decoration here, not data — the tone is fixed per metric
 * and never reacts to the value. Deliberately no red in the palette:
 * on a sales board red reads as loss, and a card that turns alarming
 * because of where it sits in a grid tells the reader something untrue.
 *
 * Every foreground is pure white rather than the usual translucent
 * hierarchy. Measured against these four backgrounds, white/90 lands
 * at 4.48:1 on the orange — under the 4.5:1 floor for body text. Full
 * white keeps all four between 5.17:1 and 5.70:1, and size plus weight
 * carry the hierarchy instead.
 */
export type CardTone = 'emerald' | 'blue' | 'orange' | 'violet'

/**
 * Hex rather than Tailwind palette classes so the contrast figures in
 * the doc comment stay true regardless of what a palette revision does
 * to `emerald-700`. Identical in light and dark mode — a saturated
 * surface needs no mode variant, which is most of why it was chosen.
 */
const TONE_BG: Record<CardTone, string> = {
  emerald: 'bg-[#047857]', // 5.48:1 on white
  blue: 'bg-[#2563eb]', // 5.17:1
  orange: 'bg-[#c2410c]', // 5.18:1
  violet: 'bg-[#7c3aed]', // 5.70:1
}

interface SalesMetricCardProps {
  title: string
  /** Pre-formatted for display — this component never formats. */
  value: string
  icon: ComponentType<{ className?: string }>
  tone: CardTone
  /** Secondary line under the divider. Omitted when there's nothing to say. */
  subtitle?: string
}

export function SalesMetricCard({
  title,
  value,
  icon: Icon,
  tone,
  subtitle,
}: SalesMetricCardProps) {
  return (
    <div
      className={`flex flex-col rounded-xl p-5 text-white shadow-sm ${TONE_BG[tone]}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <div
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white/20"
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>

      <p className="mt-3 text-[28px] font-bold leading-none tabular-nums">
        {value}
      </p>

      {subtitle && (
        // mt-auto pins the footer to the bottom so the dividers line up
        // across a row of cards whose titles wrap to different heights.
        <p className="mt-auto pt-3 text-xs">
          <span className="block border-t border-white/30 pt-2.5">
            {subtitle}
          </span>
        </p>
      )}
    </div>
  )
}
