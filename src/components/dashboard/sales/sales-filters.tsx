'use client'

import { useTranslations } from 'next-intl'
import { CalendarRange, RotateCcw } from 'lucide-react'

import type { LeadSource, Pipeline, Product, Profile } from '@/types'

/**
 * Filter state for the sales dashboard.
 *
 * `mode` decides which of the two date shapes is authoritative:
 * `month` (the reference-month selector, the common case) or `range`
 * (an explicit from/to). Keeping both in state means switching back to
 * a month doesn't lose the custom dates the user typed.
 */
export interface SalesFilterState {
  mode: 'month' | 'range'
  /** `<input type="month">` value, e.g. "2026-08". */
  month: string
  /** `<input type="date">` values for the custom range. */
  rangeFrom: string
  rangeTo: string
  pipelineId: string
  assignedTo: string
  productId: string
  sourceId: string
}

export function currentMonthValue(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function defaultFilters(): SalesFilterState {
  return {
    mode: 'month',
    month: currentMonthValue(),
    rangeFrom: '',
    rangeTo: '',
    pipelineId: '',
    assignedTo: '',
    productId: '',
    sourceId: '',
  }
}

/**
 * Resolve the filter state into the half-open ISO interval the query
 * uses. Boundaries are local-midnight, matching the rest of the
 * dashboard: a business user asking for August means their August, not
 * UTC's.
 */
export function resolvePeriod(f: SalesFilterState): { from: string; to: string } {
  if (f.mode === 'range' && f.rangeFrom && f.rangeTo) {
    const from = startOfDay(f.rangeFrom)
    // `to` is exclusive, so the picked end date is pushed to the
    // following midnight — otherwise everything that happened on the
    // last day of the range would fall outside it.
    const to = startOfDay(f.rangeTo)
    to.setDate(to.getDate() + 1)
    return { from: from.toISOString(), to: to.toISOString() }
  }

  const [y, m] = f.month.split('-').map(Number)
  const from = new Date(y, (m || 1) - 1, 1)
  const to = new Date(y, m || 1, 1)
  return { from: from.toISOString(), to: to.toISOString() }
}

function startOfDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

interface SalesFiltersProps {
  value: SalesFilterState
  onChange: (next: SalesFilterState) => void
  pipelines: Pipeline[]
  profiles: Profile[]
  products: Product[]
  sources: LeadSource[]
}

export function SalesFilters({
  value,
  onChange,
  pipelines,
  profiles,
  products,
  sources,
}: SalesFiltersProps) {
  const t = useTranslations('Dashboard.sales.filters')

  const set = (patch: Partial<SalesFilterState>) => onChange({ ...value, ...patch })

  const isDirty =
    value.mode !== 'month' ||
    value.month !== currentMonthValue() ||
    !!value.pipelineId ||
    !!value.assignedTo ||
    !!value.productId ||
    !!value.sourceId

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-3">
      {/* Period */}
      <Field label={value.mode === 'month' ? t('reference') : t('from')}>
        {value.mode === 'month' ? (
          <input
            type="month"
            value={value.month}
            onChange={(e) => set({ month: e.target.value || currentMonthValue() })}
            className={controlClass}
            aria-label={t('reference')}
          />
        ) : (
          <input
            type="date"
            value={value.rangeFrom}
            onChange={(e) => set({ rangeFrom: e.target.value })}
            className={controlClass}
            aria-label={t('from')}
          />
        )}
      </Field>

      {value.mode === 'range' && (
        <Field label={t('to')}>
          <input
            type="date"
            value={value.rangeTo}
            onChange={(e) => set({ rangeTo: e.target.value })}
            className={controlClass}
            aria-label={t('to')}
          />
        </Field>
      )}

      <button
        type="button"
        onClick={() =>
          set({
            mode: value.mode === 'month' ? 'range' : 'month',
            // Seed the custom range from the month being viewed so the
            // switch starts from what is already on screen.
            ...(value.mode === 'month' && !value.rangeFrom
              ? seedRangeFromMonth(value.month)
              : {}),
          })
        }
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <CalendarRange className="h-3.5 w-3.5" />
        {value.mode === 'month' ? t('useRange') : t('useMonth')}
      </button>

      <Field label={t('pipeline')}>
        <select
          value={value.pipelineId}
          onChange={(e) => set({ pipelineId: e.target.value })}
          className={controlClass}
          aria-label={t('pipeline')}
        >
          <option value="">{t('all')}</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('seller')}>
        <select
          value={value.assignedTo}
          onChange={(e) => set({ assignedTo: e.target.value })}
          className={controlClass}
          aria-label={t('seller')}
        >
          <option value="">{t('all')}</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name || p.email}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('product')}>
        <select
          value={value.productId}
          onChange={(e) => set({ productId: e.target.value })}
          className={controlClass}
          aria-label={t('product')}
        >
          <option value="">{t('all')}</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('source')}>
        <select
          value={value.sourceId}
          onChange={(e) => set({ sourceId: e.target.value })}
          className={controlClass}
          aria-label={t('source')}
        >
          <option value="">{t('all')}</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      {isDirty && (
        <button
          type="button"
          onClick={() => onChange(defaultFilters())}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('reset')}
        </button>
      )}
    </div>
  )
}

const controlClass =
  'h-9 w-full min-w-[130px] rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-[130px] flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  )
}

function seedRangeFromMonth(month: string): Pick<SalesFilterState, 'rangeFrom' | 'rangeTo'> {
  const [y, m] = month.split('-').map(Number)
  const first = new Date(y, (m || 1) - 1, 1)
  const last = new Date(y, m || 1, 0)
  return { rangeFrom: isoDate(first), rangeTo: isoDate(last) }
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}
