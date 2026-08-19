/**
 * Cashflow — what the book pays out, and what is sitting there waiting to be collected.
 *
 * The per-day and per-year figures are *modelled* from each position's own APR, not measured. A
 * position that reports no APR contributes nothing rather than being estimated, so the number errs
 * low by construction. What is ready to harvest, by contrast, is real: it is on-chain right now.
 *
 * Claimable totals and the per-token breakdown deliberately live on the DeFi stat row instead of
 * here — one number, one place, or the two drift.
 */

import { Coins, HandCoins } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cashflow, lpPositions } from './derive'
import { formatUsd } from './format'
import type { Ctx } from './derive'
import { MetaPill, StatCard } from './wealth-ui'

/** Below this, a position is not worth the gas to harvest. */
const MIN_HARVEST_USD = 1

export function HarvestPanel({ ctx }: { ctx: Ctx }) {
  const rows = lpPositions(ctx.data)
  if (!rows.length) return null

  const flow = cashflow(rows, MIN_HARVEST_USD)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Projected yield</CardTitle>
          <p className="text-xs text-muted-foreground">
            Modelled from each position's own APR — one reporting none contributes nothing, so this
            errs low rather than guessing
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <StatCard label="Per day" value={flow.perDay > 0 ? formatUsd(flow.perDay) : '—'} hint="projected" />
          <StatCard label="Per year" value={flow.perYear > 0 ? formatUsd(flow.perYear) : '—'} hint="projected" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Ready to harvest</CardTitle>
          <p className="text-xs text-muted-foreground">
            Positions holding at least {formatUsd(MIN_HARVEST_USD)}, largest first
          </p>
        </CardHeader>
        <CardContent>
          {flow.harvest.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Coins className="size-4 shrink-0" />
              Nothing worth collecting yet.
            </div>
          ) : (
            <div className="space-y-1">
              {flow.harvest.map((row) => {
                const share = flow.claimable > 0 ? (row.fees / flow.claimable) * 100 : 0
                return (
                  <div key={row.key} className="flex items-center gap-3 border-t py-2 first:border-t-0">
                    <HandCoins className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{row.pair}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        <MetaPill>{row.protocol}</MetaPill>
                        <MetaPill>{row.chain}</MetaPill>
                      </div>
                    </div>
                    <div className="shrink-0 text-right tabular-nums">
                      <p className="text-sm font-medium text-emerald-600 dark:text-emerald-500">
                        {formatUsd(row.fees)}
                      </p>
                      <p className="text-xs text-muted-foreground">{share.toFixed(0)}% of total</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
