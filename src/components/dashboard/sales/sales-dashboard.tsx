'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  DollarSign,
  Filter,
  Percent,
  RefreshCw,
  Target,
  Wallet,
} from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrencyExact } from '@/lib/currency'
import { loadSalesSummary, UNASSIGNED, type SalesSummary } from '@/lib/dashboard/sales'
import type { LeadSource, Pipeline, Product, Profile } from '@/types'

import { SkeletonCard, Skeleton } from '@/components/dashboard/skeleton'
import { SalesMetricCard } from './sales-metric-card'
import {
  BarList,
  ColumnChart,
  DonutLegend,
  GoalGauge,
  SalesDonut,
  type ChartSlice,
} from './sales-charts'
import {
  SalesFilters,
  defaultFilters,
  resolvePeriod,
  type SalesFilterState,
} from './sales-filters'

/**
 * Sales dashboard — the "Vendas" tab of the Painel.
 *
 * Revenue figures describe the selected period (deals that closed
 * inside it); the "aberto" figures describe the present. That split is
 * deliberate and is spelled out in the card subtitles, because two
 * numbers on one screen that answer different questions are otherwise
 * read as if they answered the same one.
 */
export function SalesDashboard() {
  const supabase = useMemo(() => createClient(), [])
  const { defaultCurrency } = useAuth()
  const t = useTranslations('Dashboard.sales')

  const [filters, setFilters] = useState<SalesFilterState>(defaultFilters)
  const [summary, setSummary] = useState<SalesSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [failed, setFailed] = useState(false)

  // Filter option sources. Loaded once — they change far less often
  // than the numbers do.
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [sources, setSources] = useState<LeadSource[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [pl, pr, pd, sr] = await Promise.all([
        supabase.from('pipelines').select('*').order('created_at'),
        supabase.from('profiles').select('*').order('full_name'),
        supabase.from('products').select('*').eq('is_active', true).order('name'),
        supabase.from('lead_sources').select('*').eq('is_active', true).order('name'),
      ])
      if (cancelled) return
      setPipelines((pl.data ?? []) as Pipeline[])
      setProfiles((pr.data ?? []) as Profile[])
      setProducts((pd.data ?? []) as Product[])
      setSources((sr.data ?? []) as LeadSource[])
    })()
    return () => {
      cancelled = true
    }
  }, [supabase])

  const period = useMemo(() => resolvePeriod(filters), [filters])

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const data = await loadSalesSummary(supabase, {
        from: period.from,
        to: period.to,
        pipelineId: filters.pipelineId || undefined,
        assignedTo: filters.assignedTo || undefined,
        productId: filters.productId || undefined,
        sourceId: filters.sourceId || undefined,
      })
      setSummary(data)
    } catch (err) {
      console.error('[sales dashboard] load failed:', err)
      setFailed(true)
    }
  }, [supabase, period, filters.pipelineId, filters.assignedTo, filters.productId, filters.sourceId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await load()
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  async function handleRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const currency = defaultCurrency

  // Buckets with no owner/product/source carry an empty name from the
  // query layer; naming them is a presentation decision, so it happens
  // here where the translations live.
  const label = useCallback(
    (slice: ChartSlice, fallback: string): ChartSlice =>
      slice.id === UNASSIGNED || !slice.name ? { ...slice, name: fallback } : slice,
    [],
  )

  const byProduct = useMemo(
    () => (summary?.byProduct ?? []).map((s) => label(s, t('noProduct'))),
    [summary, label, t],
  )
  const bySeller = useMemo(
    () => (summary?.bySeller ?? []).map((s) => label(s, t('unassigned'))),
    [summary, label, t],
  )
  const bySource = useMemo(
    () => (summary?.bySource ?? []).map((s) => label(s, t('noSource'))),
    [summary, label, t],
  )
  const openBySeller = useMemo(
    () => (summary?.openBySeller ?? []).map((s) => label(s, t('unassigned'))),
    [summary, label, t],
  )
  const openByStage = useMemo(
    () => (summary?.openByStage ?? []).map((s) => label(s, t('noStage'))),
    [summary, label, t],
  )

  const dealCount = useCallback(
    (count: number) => t('dealCount', { count }),
    [t],
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('description')}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
          />
          {t('refresh')}
        </button>
      </div>

      <SalesFilters
        value={filters}
        onChange={setFilters}
        pipelines={pipelines}
        profiles={profiles}
        products={products}
        sources={sources}
      />

      {failed && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {t('loadFailed')}
        </p>
      )}

      {/* Cards + gauge */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-3">
          {loading || !summary ? (
            Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
          ) : (
            <>
              <SalesMetricCard
                tone="emerald"
                title={t('won')}
                value={formatCurrencyExact(summary.wonValue, currency)}
                icon={DollarSign}
                subtitle={t('wonSubtitle', { count: summary.wonCount })}
              />
              <SalesMetricCard
                tone="blue"
                title={t('conversion')}
                value={
                  summary.conversion == null
                    ? '—'
                    : `${(summary.conversion * 100).toFixed(1)}%`
                }
                icon={Percent}
                subtitle={t('conversionSubtitle', {
                  won: summary.wonCount,
                  closed: summary.wonCount + summary.lostCount,
                })}
              />
              <SalesMetricCard
                tone="orange"
                title={t('openValue')}
                value={formatCurrencyExact(summary.openValue, currency)}
                icon={Wallet}
                subtitle={t('openSubtitle', { count: summary.openCount })}
              />
              <SalesMetricCard
                tone="violet"
                title={t('goal')}
                value={
                  summary.goal == null
                    ? '—'
                    : formatCurrencyExact(summary.goal, currency)
                }
                icon={Target}
                subtitle={
                  summary.goal == null ? t('goalMissing') : t('goalSubtitle')
                }
              />
            </>
          )}
        </div>

        <Panel title={t('attainment')} className="lg:col-span-1">
          {loading || !summary ? (
            <Skeleton className="h-44 w-full" />
          ) : summary.attainment == null ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              {t('goalMissingHint')}
            </p>
          ) : (
            <GoalGauge
              attainment={summary.attainment}
              label={t('ofGoal')}
              ariaLabel={t('attainmentAria', {
                percent: Math.round(summary.attainment * 100),
              })}
            />
          )}
        </Panel>
      </div>

      {/* Products + seller ranking */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Panel
          title={t('byProduct')}
          description={t('byProductDesc')}
          className="lg:col-span-2"
        >
          {loading || !summary ? (
            <Skeleton className="h-56 w-full" />
          ) : byProduct.length === 0 ? (
            <Empty label={t('emptyPeriod')} />
          ) : (
            <>
              <SalesDonut
                slices={byProduct}
                currency={currency}
                centerLabel={t('won')}
                ariaLabel={t('byProductAria')}
              />
              <DonutLegend
                slices={byProduct}
                currency={currency}
                unitsLabel={(units) => t('units', { count: units })}
              />
            </>
          )}
        </Panel>

        <Panel
          title={t('sellerRanking')}
          description={t('sellerRankingDesc')}
          className="lg:col-span-3"
        >
          {loading || !summary ? (
            <Skeleton className="h-56 w-full" />
          ) : (
            <ColumnChart
              items={bySeller}
              currency={currency}
              emptyLabel={t('emptyPeriod')}
            />
          )}
        </Panel>
      </div>

      {/* Origin + open breakdowns */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title={t('bySource')} description={t('bySourceDesc')}>
          {loading || !summary ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <BarList
              items={bySource}
              currency={currency}
              emptyLabel={t('emptyPeriod')}
              countLabel={dealCount}
            />
          )}
        </Panel>

        <Panel title={t('openByStage')} description={t('openNowDesc')}>
          {loading || !summary ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <BarList
              items={openByStage}
              currency={currency}
              emptyLabel={t('emptyOpen')}
              countLabel={dealCount}
            />
          )}
        </Panel>

        <Panel title={t('openBySeller')} description={t('openNowDesc')}>
          {loading || !summary ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <BarList
              items={openBySeller}
              currency={currency}
              emptyLabel={t('emptyOpen')}
              countLabel={dealCount}
            />
          )}
        </Panel>
      </div>
    </div>
  )
}

function Panel({
  title,
  description,
  className,
  children,
}: {
  title: string
  description?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      className={`flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card ${className ?? ''}`}
    >
      {/* `card-2` is the theme's slightly-raised surface token. Giving
          the header its own step separates the label from the chart in
          both modes without introducing a colour of its own — the
          charts below already carry all the colour this panel needs. */}
      <header className="border-b border-border bg-card-2 px-5 py-4">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="flex flex-1 flex-col p-5">{children}</div>
    </section>
  )
}

function Empty({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8">
      <Filter className="h-8 w-8 text-muted-foreground" aria-hidden />
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
