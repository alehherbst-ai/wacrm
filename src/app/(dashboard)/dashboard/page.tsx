"use client"

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { BarChart3, LayoutDashboard } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DashboardOverview } from '@/components/dashboard/overview'
import { SalesDashboard } from '@/components/dashboard/sales/sales-dashboard'

type PanelTab = 'overview' | 'sales'

/**
 * Painel. Two tabs over the same page: the original operational
 * overview, and the sales dashboard.
 *
 * The active tab lives in component state rather than the URL. The
 * settings page pays for its `?tab=` deep links with a Suspense
 * boundary (see the note there); nothing links into a specific Painel
 * tab, so that cost buys nothing here.
 *
 * Both panels mount lazily — `TabsContent` renders nothing until its
 * tab is opened, so the sales queries don't run for someone who only
 * ever looks at the overview.
 */
export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')
  const [tab, setTab] = useState<PanelTab>('overview')

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as PanelTab)}
        className="gap-5"
      >
        <TabsList>
          <TabsTrigger value="overview" className="px-3">
            <LayoutDashboard className="size-4" />
            {t('tabOverview')}
          </TabsTrigger>
          <TabsTrigger value="sales" className="px-3">
            <BarChart3 className="size-4" />
            {t('tabSales')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <DashboardOverview />
        </TabsContent>
        <TabsContent value="sales">
          <SalesDashboard />
        </TabsContent>
      </Tabs>
    </div>
  )
}
