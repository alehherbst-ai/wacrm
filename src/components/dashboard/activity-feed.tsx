"use client"

import Link from 'next/link'
import { useState } from 'react'
import {
  MessageSquare,
  UserPlus,
  Briefcase,
  Zap,
  Inbox,
  Activity,
  ChevronRight,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { ActivityItem, ActivityKind } from '@/lib/dashboard/types'
import { cn } from '@/lib/utils'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface ActivityFeedProps {
  items: ActivityItem[] | null
  loading: boolean
}

const PAGE_SIZES = [5, 10, 20, 50] as const
type PageSize = (typeof PAGE_SIZES)[number]

interface KindTheme {
  icon: ComponentType<{ className?: string }>
  /** Tailwind classes for the round icon badge + label color. */
  badge: string
}

// One hue per kind, and four distinct ones — contact and deal both
// wore the accent before, which made the two most common rows in the
// feed indistinguishable at a glance. Tones come from the theme
// tokens, so they stay readable in light and dark alike.
const KIND_THEME: Record<ActivityKind, KindTheme> = {
  message: { icon: MessageSquare, badge: 'bg-info-soft text-info ring-info/20' },
  contact: { icon: UserPlus, badge: 'bg-primary-soft text-primary ring-primary/20' },
  deal: { icon: Briefcase, badge: 'bg-success-soft text-success ring-success/20' },
  automation: { icon: Zap, badge: 'bg-warn-soft text-warn ring-warn/20' },
}

import { useTranslations } from 'next-intl'

export function ActivityFeed({ items, loading }: ActivityFeedProps) {
  const t = useTranslations('Dashboard.activityFeed')
  // Start at 5 — a quick scan of the most recent events without
  // dominating vertical real estate. User expands explicitly via the
  // footer control when they want deeper history.
  const [pageSize, setPageSize] = useState<PageSize>(5)

  const totalLoaded = items?.length ?? 0
  const visible = items?.slice(0, pageSize) ?? []
  // A size option is "useful" if picking it would reveal rows the
  // smaller option doesn't already show. With PAGE_SIZES=[5,10,20,50]:
  // "10" is useful only once we've loaded ≥6 items, "20" once ≥11, etc.
  // The smallest option is always enabled.
  const isSizeUseful = (size: PageSize, i: number) =>
    i === 0 || totalLoaded > PAGE_SIZES[i - 1]

  return (
    <section className="rounded-xl border border-border-strong bg-card shadow-sm">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex size-9 flex-shrink-0 items-center justify-center rounded-lg bg-success-soft text-success ring-1 ring-success/20 ring-inset"
            aria-hidden
          >
            <Activity className="size-4" />
          </span>
          <h2 className="truncate text-sm font-semibold text-foreground">{t('title')}</h2>
        </div>
        <Link
          href="/inbox"
          className="group flex flex-shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:border-primary/40 hover:bg-primary-soft"
        >
          {t('viewAll')}
          <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </Link>
      </header>

      {loading || !items ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Inbox}
            title={t('noActivity')}
            hint={t('noActivityHint')}
          />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {visible.map((it, i) => {
              const theme = KIND_THEME[it.kind]
              const Icon = theme.icon
              // Alternating row background for scanability. bg-muted/40
              // keeps the stripe visible in both light and dark modes
              // (bg-card/40 vanishes against a white card surface in light).
              const stripe = i % 2 === 0 ? 'bg-transparent' : 'bg-muted/40'
              const row = (
                <div className="group/row flex items-center gap-3 px-5 py-2.5">
                  <span
                    className={cn(
                      'flex size-8 flex-shrink-0 items-center justify-center rounded-full ring-1 ring-inset transition-transform duration-150 group-hover/row:scale-110',
                      theme.badge,
                    )}
                    aria-hidden
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground transition-transform duration-150 group-hover/row:translate-x-0.5">
                    {it.text}
                  </span>
                  <span className="flex-shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
                    {relativeTime(it.at, t)}
                  </span>
                </div>
              )
              return (
                <li
                  key={it.id}
                  className={cn(
                    stripe,
                    // A left rail that only appears on hover marks the
                    // row you're on without shifting anything: the
                    // border is always there, just transparent.
                    // Scoped to `border-l-*` on purpose — a bare
                    // `hover:border-primary` also repaints the row's
                    // `divide-y` top edge, since divide's colour rule
                    // sits in a zero-specificity :where().
                    'border-l-2 border-l-transparent transition-colors hover:border-l-primary hover:bg-primary-soft',
                  )}
                >
                  {it.href ? (
                    <Link href={it.href} className="block">
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              )
            })}
          </ul>
          <footer className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-5 py-3 text-xs">
            <span className="font-medium text-muted-foreground tabular-nums">
              {t('showingOf', { visible: visible.length, totalLoaded, plus: totalLoaded === 50 ? '+' : '' })}
            </span>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-muted-foreground">{t('show')}</span>
              <div className="flex items-center gap-1 rounded-lg border border-border bg-card/60 p-1">
                {PAGE_SIZES.map((size, i) => {
                  const disabled = !isSizeUseful(size, i)
                  return (
                    <button
                      key={size}
                      type="button"
                      onClick={() => setPageSize(size)}
                      disabled={disabled}
                      className={cn(
                        'rounded-md px-2 py-1 font-medium tabular-nums transition-all duration-150',
                        pageSize === size
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        disabled &&
                          'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
                      )}
                    >
                      {size}
                    </button>
                  )
                })}
              </div>
            </div>
          </footer>
        </>
      )}
    </section>
  )
}

function relativeTime(iso: string, t: ReturnType<typeof useTranslations>): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('timeS', { sec: Math.max(1, diffSec) })
  if (diffSec < 3600) return t('timeM', { min: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('timeH', { hr: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('timeD', { day: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString()
}
