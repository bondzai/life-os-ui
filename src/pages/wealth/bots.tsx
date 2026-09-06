/**
 * Wealth · Bots — automated exchange strategies.
 *
 * Closer to an LP position than to a holding: capital that runs on its own and needs watching.
 * The headline is equity, but the number that matters is return on invested capital — unrealized
 * PnL against what was actually put in, not against today's equity.
 */

import { useMemo } from 'react'
import { Bot } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/core/components/empty-state'
import { cn } from '@/lib/utils'
import { useMoney } from './money'
import { botTotals, sbBotId, tradingBots, type BotRow } from './derive'
import { formatAmount, formatPct, formatRelativeTime } from './format'
import { TokenMark } from './marks'
import { StaleBanner, WealthError, WealthPageSkeleton } from './states'
import { SnowballToggle } from './snowball'
import { useWealth } from './use-wealth'
import { ChangeText, MetaPill, StatCard } from './wealth-ui'

/** Signed USD, coloured by direction. `null` is an em dash — unknown is not zero. */
function Pnl({ usd }: { usd: number | null }) {
  const { money } = useMoney()
  if (usd === null || !Number.isFinite(usd)) return <span className="text-muted-foreground">—</span>
  const up = usd >= 0
  return (
    <span className={cn('tabular-nums', up ? 'text-emerald-600 dark:text-emerald-500' : 'text-red-600 dark:text-red-500')}>
      {up ? '+' : '−'}
      {money(Math.abs(usd))}
    </span>
  )
}

/** The basket a rebalance bot holds, or the sub-bots a futures strategy is running. */
function BotDetail({ row }: { row: BotRow }) {
  const { money } = useMoney()
  const weights = row.info?.weights ?? []
  const subBots = row.info?.bots ?? []

  if (weights.length) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {weights.map((weight) => (
          <span
            key={weight.symbol}
            className="inline-flex items-center gap-1 rounded-md bg-muted py-0.5 pr-1.5 pl-0.5 text-xs tabular-nums"
            title={`${formatAmount(weight.amount)} ${weight.symbol} · ${money(weight.usd)}`}
          >
            <TokenMark symbol={weight.symbol} />
            <span className="font-medium">{weight.symbol}</span>
            <span className="text-muted-foreground">{weight.pct.toFixed(0)}%</span>
          </span>
        ))}
      </div>
    )
  }

  if (subBots.length) {
    return (
      <div className="space-y-1">
        {subBots.map((sub, index) => (
          <div key={sub.id ?? index} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{sub.id ?? `sub-bot ${index + 1}`}</span>
            <ChangeText value={sub.pnl_pct} />
            <span className="w-20 shrink-0 text-right tabular-nums">
              <Pnl usd={sub.pnl_usd} />
            </span>
          </div>
        ))}
      </div>
    )
  }

  return <span className="text-xs text-muted-foreground">—</span>
}

export function WealthBotsPage() {
  const { money } = useMoney()
  const { ctx, isLoading, error, isRefreshing, isStale, refetch } = useWealth()

  const { rows, totals } = useMemo(() => {
    const rows = ctx ? tradingBots(ctx.data) : []
    return { rows, totals: botTotals(rows) }
  }, [ctx])

  if (isLoading) return <WealthPageSkeleton />
  if (error) return <WealthError detail={error.message} onRetry={refetch} />

  if (!rows.length) {
    return (
      <EmptyState
        icon={Bot}
        title="No active trading bots"
        description="Rebalance and futures bots running on your connected exchange account appear here with live weights and PnL."
      />
    )
  }

  return (
    <div className="space-y-4">
      {isStale && ctx && <StaleBanner age={formatRelativeTime(ctx.data.fetched_at)} onRefresh={refetch} refreshing={isRefreshing} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Bot equity"
          value={money(totals.equity)}
          accent
          hint={`${rows.length} ${rows.length === 1 ? 'strategy' : 'strategies'}${totals.subBots ? ` · ${totals.subBots} sub-bots` : ''}`}
        />
        <StatCard
          label="Unrealized PnL"
          value={<Pnl usd={totals.pnl} />}
          hint={
            totals.returnPct === null
              ? 'no invested capital to measure against'
              : `${formatPct(totals.returnPct)} on capital invested`
          }
        />
        <StatCard
          label="Margin in use"
          value={totals.margin > 0 ? money(totals.margin) : '—'}
          hint="futures collateral"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Strategies</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Strategy</TableHead>
                <TableHead className="hidden md:table-cell">Holds</TableHead>
                <TableHead className="text-right">Equity</TableHead>
                <TableHead className="text-right">PnL</TableHead>
                <TableHead className="text-right">%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <SnowballToggle id={sbBotId(row.key)} name={row.label} className="-ml-1.5" />
                      <span className="font-medium">{row.label}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      <MetaPill>{row.account}</MetaPill>
                      {row.category && <MetaPill>{row.category}</MetaPill>}
                      {row.subBots > 0 && <MetaPill>{row.subBots} sub-bots</MetaPill>}
                    </div>
                    <div className="mt-2 md:hidden">
                      <BotDetail row={row} />
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-xs md:table-cell">
                    <BotDetail row={row} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.usd)}</TableCell>
                  <TableCell className="text-right">
                    <Pnl usd={row.pnlUsd} />
                  </TableCell>
                  <TableCell className="text-right">
                    <ChangeText value={row.pnlPct} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
