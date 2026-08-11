import { cn } from '@/lib/utils'

/**
 * Shared skeleton primitive — a pulsing slate block sized to whatever
 * container it's dropped into. Used by every dashboard widget while
 * its data fetches.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        // Matches MetricCard's chrome (strong border, shadow, top rail)
        // so the row doesn't visibly re-flow when the data lands.
        'relative overflow-hidden rounded-xl border border-border-strong bg-card p-5 shadow-sm',
        className,
      )}
    >
      <span className="absolute inset-x-0 top-0 h-[3px] bg-muted" aria-hidden />
      <div className="flex items-start justify-between">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="size-9 rounded-lg" />
      </div>
      <Skeleton className="mt-4 h-8 w-20" />
      <Skeleton className="mt-3 h-4 w-24" />
    </div>
  )
}
