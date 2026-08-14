/**
 * The four data states every wealth panel must handle: loading, empty, error, stale.
 *
 * They live together so all three surfaces treat them identically. The rule worth keeping is that
 * a failed fetch must never render as "empty" — "no positions" and "we could not reach the
 * server" look the same on screen but mean opposite things, and confusing them tells someone
 * their money is gone.
 */

import { AlertTriangle, RotateCw, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Loading placeholder for a stat card row. */
export function StatCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <CardContent className="space-y-2 py-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-28" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/** Loading placeholder for a table/ledger body. */
export function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  )
}

export function ChartSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn('h-[220px] w-full', className)} />
}

/** Whole-page loading shape, so the layout does not jump when data arrives. */
export function WealthPageSkeleton() {
  return (
    <div className="space-y-4">
      <StatCardsSkeleton />
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <ChartSkeleton />
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Error state. Always names the cause and offers the retry, because the alternative — a blank
 * panel — makes a transient network blip indistinguishable from an emptied wallet.
 */
export function WealthError({
  title = 'Couldn’t load your portfolio',
  detail,
  onRetry,
  retrying,
}: {
  title?: string
  detail?: string
  onRetry?: () => void
  retrying?: boolean
}) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <span className="grid size-11 place-items-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" />
        </span>
        <div>
          <h3 className="text-base font-medium">{title}</h3>
          {detail && <p className="mt-1 max-w-md text-sm text-muted-foreground">{detail}</p>}
        </div>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
            <RotateCw className={cn('mr-1 size-3.5', retrying && 'animate-spin')} />
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Stale-data notice.
 *
 * Shown rather than hiding the numbers: old data is still useful, but only if the user knows
 * it is old. Silently showing an hour-old balance during a crash is the worst outcome.
 */
export function StaleBanner({ age, onRefresh, refreshing }: { age: string; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <Clock className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />
      <span className="text-amber-700 dark:text-amber-400">Prices last updated {age}.</span>
      {onRefresh && (
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onRefresh} disabled={refreshing}>
          <RotateCw className={cn('mr-1 size-3', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      )}
    </div>
  )
}
