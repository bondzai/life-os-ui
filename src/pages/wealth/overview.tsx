/**
 * Wealth · Overview — what everything is worth, split by tier, and where it has been.
 *
 * The headline number is net worth (debt already subtracted); the tier split and the history
 * chart answer the two follow-up questions. Anything that needs a table lives on Holdings or
 * DeFi — this page is meant to be readable in one glance.
 */

import { useMemo, useState } from 'react'
import { Wallet } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { EmptyState } from '@/core/components/empty-state'
import { BorrowingPanel } from './borrowing'
import { SnowballPanel } from './snowball'
import { cn } from '@/lib/utils'
import {
  HISTORY_WINDOWS,
  TIER_LABELS,
  claimableUsd,
  holdings,
  lendingPositions,
  lpPositions,
  netWorth,
  portfolioChange,
  sumUsd,
  tierTotals,
  windowPerf,
} from './derive'
import { useMoney } from './money'
import { formatPct, formatRelativeTime } from './format'
import { ChartSkeleton, StaleBanner, WealthError, WealthPageSkeleton } from './states'
import type { Tier } from './types'
import { useWealth, useWealthHistory } from './use-wealth'
import { ChangeBadge, StatCard } from './wealth-ui'

const TIER_BAR: Record<Tier, string> = {
  store: 'bg-chart-1',
  business: 'bg-chart-2',
  trading: 'bg-chart-3',
}

const TIER_HINT: Record<Tier, string> = {
  store: 'Long-term reserves',
  business: 'Capital put to work',
  trading: 'Active positions',
}

export function WealthOverviewPage() {
  const { money, compact } = useMoney()
  const { ctx, isLoading, error, isEmpty, isRefreshing, ageSeconds, isStale, refetch } = useWealth()
  const history = useWealthHistory()
  const [windowDays, setWindowDays] = useState<number>(30)

  const metrics = useMemo(() => {
    if (!ctx) return null
    const rows = holdings(ctx)
    const totals = tierTotals(rows)
    const gross = sumUsd(rows)
    const lends = lendingPositions(ctx.data)
    const lps = lpPositions(ctx.data)
    return {
      net: netWorth(ctx, rows),
      gross,
      change: portfolioChange(rows),
      totals,
      // "At work" excludes the store tier: reserves are meant to sit still.
      atWork: totals.business + totals.trading,
      debt: lends.reduce((sum, l) => sum + l.debt_usd, 0),
      claimable: claimableUsd(lps),
      positions: rows.length,
    }
  }, [ctx])

  const perf = useMemo(
    () => (history.points.length ? windowPerf(history.points, windowDays) : null),
    [history.points, windowDays],
  )

  const chartData = useMemo(
    () => (perf?.points ?? []).map((p) => ({ d: p.d, v: p.v, label: new Date(p.d).toLocaleDateString() })),
    [perf],
  )

  if (isLoading) return <WealthPageSkeleton />

  if (error) {
    return <WealthError detail={error.message} onRetry={refetch} retrying={isRefreshing} />
  }

  if (isEmpty || !ctx || !metrics) {
    return (
      <EmptyState
        icon={Wallet}
        title="No wallets connected"
        description="Add a wallet address in settings to start tracking your portfolio. Balances are read from public data — no keys required."
      />
    )
  }

  const { totals, gross } = metrics
  const deployedPct = gross > 0 ? (metrics.atWork / gross) * 100 : 0

  return (
    <div className="space-y-4">
      {isStale && ageSeconds !== null && (
        <StaleBanner
          age={formatRelativeTime(ctx.data.fetched_at)}
          onRefresh={refetch}
          refreshing={isRefreshing}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Net worth"
          accent
          value={compact(metrics.net)}
          hint={metrics.debt > 0 ? `after ${compact(metrics.debt)} debt` : 'no outstanding debt'}
        />
        <StatCard
          label="24h change"
          value={<ChangeBadge value={metrics.change} className="text-xl" />}
          hint="value-weighted across holdings"
        />
        <StatCard
          label="Capital at work"
          value={compact(metrics.atWork)}
          hint={`${deployedPct.toFixed(0)}% of gross deployed`}
        />
        <StatCard
          label="Claimable"
          value={money(metrics.claimable)}
          hint="uncollected LP fees & rewards"
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <div>
            <CardTitle className="text-sm font-medium">Net worth over time</CardTitle>
            {perf && (
              <p className="mt-1 text-xs text-muted-foreground">
                <span className={cn('font-medium', perf.delta >= 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-red-600 dark:text-red-500')}>
                  {perf.delta >= 0 ? '+' : '−'}{money(Math.abs(perf.delta))}
                </span>
                {perf.pct !== null && <> ({formatPct(perf.pct)})</>} over {perf.spanDays}d
                {' · '}low {compact(perf.low)} · high {compact(perf.high)}
              </p>
            )}
          </div>
          <div className="flex gap-1">
            {HISTORY_WINDOWS.map((w) => (
              <Button
                key={w.label}
                size="sm"
                variant={windowDays === w.days ? 'secondary' : 'ghost'}
                className="h-7 px-2 text-xs"
                onClick={() => setWindowDays(w.days)}
              >
                {w.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {history.isLoading ? (
            <ChartSkeleton />
          ) : chartData.length < 2 ? (
            // Not an error: a new install genuinely has no history yet, and saying so beats
            // drawing a flat line that looks like the portfolio never moved.
            <p className="py-12 text-center text-sm text-muted-foreground">
              Not enough history yet — snapshots build up daily.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="nwFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                  width={52}
                  tickFormatter={(v) => compact(Number(v))}
                />
                <Tooltip
                  formatter={(v) => [money(Number(v)), 'Net worth']}
                  labelFormatter={(l) => String(l)}
                  contentStyle={{
                    background: 'var(--popover)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: 'var(--popover-foreground)',
                  }}
                />
                <Area type="monotone" dataKey="v" stroke="var(--chart-1)" strokeWidth={2} fill="url(#nwFill)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Asset tiers</CardTitle>
          <p className="text-xs text-muted-foreground">
            Gross of debt, so this always reconciles with Holdings.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
            {(Object.keys(TIER_LABELS) as Tier[]).map((tier) => {
              const pct = gross > 0 ? (totals[tier] / gross) * 100 : 0
              if (pct <= 0) return null
              return <div key={tier} className={cn('h-full', TIER_BAR[tier])} style={{ width: `${pct}%` }} />
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(TIER_LABELS) as Tier[]).map((tier) => {
              const usd = totals[tier]
              const pct = gross > 0 ? (usd / gross) * 100 : 0
              return (
                <div key={tier} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <span className={cn('size-2 rounded-full', TIER_BAR[tier])} />
                      {TIER_LABELS[tier]}
                    </span>
                    <span className="text-sm font-semibold tabular-nums">{compact(usd)}</span>
                  </div>
                  <Progress value={pct} className="h-1.5" />
                  <p className="text-xs text-muted-foreground">
                    {pct.toFixed(1)}% · {TIER_HINT[tier]}
                  </p>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* The slice the user chose to compound — a different question from net worth, which is why
          it gets its own series rather than a filter on the chart above. */}
      <SnowballPanel ctx={ctx} />

      {/* Debt is the other half of net worth, so it belongs on the page that leads with it.
          Self-hiding: a wallet that does not borrow never sees this. */}
      <BorrowingPanel ctx={ctx} />
    </div>
  )
}
