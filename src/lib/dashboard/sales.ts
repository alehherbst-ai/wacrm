import type { SupabaseClient } from '@supabase/supabase-js'

// ------------------------------------------------------------
// Sales dashboard: one fetch, many breakdowns.
//
// Like the rest of `lib/dashboard`, aggregation happens on the client
// and RLS scopes every read to the caller's account — no user_id or
// account_id is passed explicitly. The volumes involved (a pipeline's
// deals for one month) are far below the point where this would need
// to become a SQL view or RPC.
//
// Two populations, deliberately kept apart:
//
//   * CLOSED — deals whose `closed_at` falls inside the period. This
//     is revenue: won/lost, conversion, per-product, per-seller,
//     per-source. It is a statement about a slice of time.
//
//   * OPEN — deals that are open *right now*, regardless of period.
//     "Valor em aberto" is a statement about the present; filtering it
//     by month would answer a question nobody asks ("deals that were
//     open during August"), and the number would keep changing after
//     the month ended.
// ------------------------------------------------------------

export interface SalesFilters {
  /** Inclusive ISO start of the reference period. */
  from: string
  /** Exclusive ISO end of the reference period. */
  to: string
  /** Restrict to a single pipeline. Empty = every pipeline. */
  pipelineId?: string
  /** `deals.assigned_to` (a profile id). Empty = everyone. */
  assignedTo?: string
  /** Only deals carrying this product as a line item. Empty = all. */
  productId?: string
  /** `deals.source_id`. Empty = every origin, including unattributed. */
  sourceId?: string
}

export interface Slice {
  id: string
  name: string
  color?: string
  count: number
  value: number
}

export interface ProductSlice extends Slice {
  /** Summed quantity across line items — the "25 un." in the legend. */
  units: number
}

export interface SalesSummary {
  wonCount: number
  wonValue: number
  lostCount: number
  lostValue: number
  /** Won ÷ closed, as a 0–1 fraction. Null when nothing closed. */
  conversion: number | null
  openCount: number
  openValue: number
  /** Target for the period, or null when none is configured. */
  goal: number | null
  /** wonValue ÷ goal, 0–1+. Null when there is no goal. */
  attainment: number | null
  byProduct: ProductSlice[]
  bySeller: Slice[]
  bySource: Slice[]
  openByStage: Slice[]
  openBySeller: Slice[]
}

/** Bucket id used when a deal has no product / seller / source. */
export const UNASSIGNED = '__none__'

// Shape of the rows the two queries below return. Written out rather
// than inferred because PostgREST embeds come back as `any`.
export interface DealRow {
  id: string
  value: number | string | null
  status: 'open' | 'won' | 'lost' | null
  closed_at: string | null
  assigned_to: string | null
  source_id: string | null
  stage_id: string
  stage?: { id: string; name: string; color: string; position: number } | null
  assignee?: { id: string; full_name: string | null; email: string | null } | null
  source?: { id: string; name: string; color: string } | null
  items?: {
    product_id: string
    quantity: number | string
    unit_price: number | string
    product?: { id: string; name: string } | null
  }[]
}

const DEAL_SELECT = `
  id, value, status, closed_at, assigned_to, source_id, stage_id,
  stage:pipeline_stages(id, name, color, position),
  assignee:profiles!deals_assigned_to_fkey(id, full_name, email),
  source:lead_sources(id, name, color),
  items:deal_products(product_id, quantity, unit_price, product:products(id, name))
`

const num = (v: number | string | null | undefined): number => Number(v ?? 0) || 0

/**
 * Value each line item contributes.
 *
 * Normally this is quantity × unit_price. When the deal carries a
 * manually overridden value, the items are scaled to match it, so the
 * per-product chart always adds up to the revenue shown on the cards —
 * a 10% discount on the deal shows as 10% off each product rather than
 * as an unexplained gap between two numbers on the same screen. A deal
 * with no items at all contributes its whole value to the "no product"
 * bucket for the same reason.
 */
export function itemValues(deal: DealRow): { productId: string; name: string; units: number; value: number }[] {
  const dealValue = num(deal.value)
  const items = deal.items ?? []
  if (items.length === 0) {
    return [{ productId: UNASSIGNED, name: '', units: 0, value: dealValue }]
  }

  const raw = items.map((it) => ({
    productId: it.product_id,
    name: it.product?.name ?? '',
    units: num(it.quantity),
    value: num(it.quantity) * num(it.unit_price),
  }))
  const sum = raw.reduce((s, r) => s + r.value, 0)

  // No scaling when the sum already matches (the common case), or when
  // it is zero and there is nothing to distribute proportionally.
  if (sum === 0 || Math.abs(sum - dealValue) < 0.005) return raw
  const factor = dealValue / sum
  return raw.map((r) => ({ ...r, value: r.value * factor }))
}

function bump(
  map: Map<string, Slice>,
  id: string,
  name: string,
  value: number,
  color?: string,
) {
  const current = map.get(id)
  if (current) {
    current.count += 1
    current.value += value
    return
  }
  map.set(id, { id, name, color, count: 1, value })
}

const byValueDesc = (a: Slice, b: Slice) => b.value - a.value

export async function loadSalesSummary(
  db: SupabaseClient,
  filters: SalesFilters,
): Promise<SalesSummary> {
  const closedQuery = db
    .from('deals')
    .select(DEAL_SELECT)
    .in('status', ['won', 'lost'])
    .gte('closed_at', filters.from)
    .lt('closed_at', filters.to)

  const openQuery = db.from('deals').select(DEAL_SELECT).eq('status', 'open')

  for (const q of [closedQuery, openQuery]) {
    if (filters.pipelineId) q.eq('pipeline_id', filters.pipelineId)
    if (filters.assignedTo) q.eq('assigned_to', filters.assignedTo)
    if (filters.sourceId) q.eq('source_id', filters.sourceId)
  }

  const [closedRes, openRes, goal] = await Promise.all([
    closedQuery,
    openQuery,
    loadGoal(db, filters),
  ])

  if (closedRes.error) throw closedRes.error
  if (openRes.error) throw openRes.error

  // The product filter is applied here rather than in the query on
  // purpose: an embedded `!inner` filter would also strip the deal's
  // other line items, and the per-product chart would then quietly
  // report a filtered deal as if it had sold one product.
  const keep = (rows: DealRow[]) =>
    filters.productId
      ? rows.filter((d) =>
          (d.items ?? []).some((i) => i.product_id === filters.productId),
        )
      : rows

  const closed = keep((closedRes.data ?? []) as unknown as DealRow[])
  const open = keep((openRes.data ?? []) as unknown as DealRow[])

  const won = closed.filter((d) => d.status === 'won')
  const lost = closed.filter((d) => d.status === 'lost')

  const wonValue = won.reduce((s, d) => s + num(d.value), 0)
  const lostValue = lost.reduce((s, d) => s + num(d.value), 0)
  const openValue = open.reduce((s, d) => s + num(d.value), 0)

  // --- breakdowns over won deals (revenue) ---
  const products = new Map<string, ProductSlice>()
  const sellers = new Map<string, Slice>()
  const sources = new Map<string, Slice>()

  for (const deal of won) {
    for (const item of itemValues(deal)) {
      const current = products.get(item.productId)
      if (current) {
        current.count += 1
        current.units += item.units
        current.value += item.value
      } else {
        products.set(item.productId, {
          id: item.productId,
          name: item.name,
          count: 1,
          units: item.units,
          value: item.value,
        })
      }
    }

    bump(
      sellers,
      deal.assigned_to ?? UNASSIGNED,
      deal.assignee?.full_name || deal.assignee?.email || '',
      num(deal.value),
    )
    bump(
      sources,
      deal.source_id ?? UNASSIGNED,
      deal.source?.name ?? '',
      num(deal.value),
      deal.source?.color,
    )
  }

  // --- breakdowns over open deals (present state) ---
  const openStages = new Map<string, Slice>()
  const openSellers = new Map<string, Slice>()

  for (const deal of open) {
    bump(
      openStages,
      deal.stage_id,
      deal.stage?.name ?? '',
      num(deal.value),
      deal.stage?.color,
    )
    bump(
      openSellers,
      deal.assigned_to ?? UNASSIGNED,
      deal.assignee?.full_name || deal.assignee?.email || '',
      num(deal.value),
    )
  }

  const closedCount = won.length + lost.length

  return {
    wonCount: won.length,
    wonValue,
    lostCount: lost.length,
    lostValue,
    conversion: closedCount > 0 ? won.length / closedCount : null,
    openCount: open.length,
    openValue,
    goal,
    attainment: goal && goal > 0 ? wonValue / goal : null,
    byProduct: [...products.values()].sort(byValueDesc),
    bySeller: [...sellers.values()].sort(byValueDesc),
    bySource: [...sources.values()].sort(byValueDesc),
    // Stages read left-to-right in pipeline order, not by size — the
    // board they mirror is ordered, and re-sorting would make the two
    // views disagree about what comes first.
    openByStage: [...openStages.values()],
    openBySeller: [...openSellers.values()].sort(byValueDesc),
  }
}

/**
 * The target the gauge measures against: every month the period
 * touches, summed. With a seller filter active it is that seller's own
 * target, so "% da meta" answers the question the filter asked. Null
 * when nothing is configured — a missing goal is not a goal of zero.
 */
async function loadGoal(
  db: SupabaseClient,
  filters: SalesFilters,
): Promise<number | null> {
  const months = monthsBetween(filters.from, filters.to)
  if (months.length === 0) return null

  let query = db
    .from('sales_goals')
    .select('target_amount, profile_id, period_month')
    .in('period_month', months)

  query = filters.assignedTo
    ? query.eq('profile_id', filters.assignedTo)
    : query.is('profile_id', null)

  const { data, error } = await query
  if (error || !data || data.length === 0) return null
  return data.reduce((s, row) => s + num(row.target_amount as number), 0)
}

/** First-of-month keys (YYYY-MM-01) covered by [from, to). */
export function monthsBetween(from: string, to: string): string[] {
  const start = new Date(from)
  const end = new Date(to)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return []

  const out: string[] = []
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  // `to` is exclusive: a period ending exactly at midnight on the 1st
  // belongs to the previous month and must not pull the next one in.
  const last = new Date(end.getTime() - 1)
  while (
    cursor.getFullYear() < last.getFullYear() ||
    (cursor.getFullYear() === last.getFullYear() &&
      cursor.getMonth() <= last.getMonth())
  ) {
    out.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-01`,
    )
    cursor.setMonth(cursor.getMonth() + 1)
    // Guard against a pathological range producing an unbounded list.
    if (out.length > 120) break
  }
  return out
}
