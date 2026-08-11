"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Zap, ArrowRight } from 'lucide-react'
import type { ComponentType } from 'react'

import { cn } from '@/lib/utils'
import { useTranslations } from 'next-intl'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string }>
  /** Full class strings — Tailwind can't see interpolated names. */
  chip: string
  hover: string
}

const ACTIONS: Action[] = [
  {
    labelKey: 'newContact',
    href: '/contacts',
    icon: UserPlus,
    chip: 'bg-info-soft text-info ring-info/20',
    hover: 'hover:border-info/40',
  },
  {
    labelKey: 'newDeal',
    href: '/pipelines',
    icon: Briefcase,
    chip: 'bg-success-soft text-success ring-success/20',
    hover: 'hover:border-success/40',
  },
  {
    labelKey: 'newAutomation',
    href: '/automations/new',
    icon: Zap,
    chip: 'bg-primary-soft text-primary ring-primary/20',
    hover: 'hover:border-primary/40',
  },
]

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')

  return (
    // sm:grid-cols-3, not 4 — there are three actions, and the fourth
    // track left a dead column on the right that read as a missing
    // card rather than as breathing room.
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className={cn(
              'group flex items-center gap-3 rounded-xl border border-border-strong bg-card px-4 py-3',
              'shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-card-2 hover:shadow-md',
              a.hover,
            )}
          >
            <span
              className={cn(
                'flex size-9 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-inset transition-transform duration-200 group-hover:scale-105',
                a.chip,
              )}
              aria-hidden
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {t(a.labelKey as string)}
            </span>
            {/* Sits at 0 opacity rather than `hidden` so the label never
                reflows when the arrow appears on hover. */}
            <ArrowRight
              className="size-4 flex-shrink-0 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100"
              aria-hidden
            />
          </Link>
        )
      })}
    </div>
  )
}
