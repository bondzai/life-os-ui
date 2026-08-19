/**
 * Wealth · BTC — how much bitcoin you actually hold, denominated in sats.
 *
 * Sats rather than dollars on purpose: the point of the page is that the number should only go up,
 * and a USD figure hides stacking behind the price. Wrappers are unwrapped, so moving cbBTC → WBTC
 * changes the breakdown and not the total.
 */

import { useMemo, useState } from 'react'
import { Bitcoin, Landmark, Link2, Snowflake, Zap } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { EmptyState } from '@/core/components/empty-state'
import { cn } from '@/lib/utils'
import { btcReserves, nextSatsMilestone, type BtcLocation } from './derive'
import { formatRelativeTime, formatUsd } from './format'
import { StaleBanner, WealthError, WealthPageSkeleton } from './states'
import { useWealth } from './use-wealth'
import { StatCard } from './wealth-ui'

/**
 * Custody kind → how it reads.
 *
 * Cold is the only one where you hold the keys, so it is the only one shown as settled. An
 * exchange or a custodial Lightning wallet is someone else's promise, and the page says so rather
 * than rolling it into one reassuring total.
 */
const CUSTODY: Record<BtcLocation['kind'], { icon: typeof Landmark; tone: string; note: string }> = {
  cold: { icon: Snowflake, tone: 'text-emerald-600 dark:text-emerald-500', note: 'self-custody' },
  cex: { icon: Landmark, tone: 'text-amber-600 dark:text-amber-500', note: 'exchange holds it' },
  custodial: { icon: Zap, tone: 'text-amber-600 dark:text-amber-500', note: 'third party holds it' },
  onchain: { icon: Link2, tone: 'text-sky-600 dark:text-sky-500', note: 'on-chain' },
}

const SATS_TARGET_KEY = 'lyra:wealth:sats-target'

function formatSats(sats: number | null): string {
  if (sats === null || !Number.isFinite(sats)) return '—'
  return Math.round(sats).toLocaleString('en-US')
}

export function WealthBtcPage() {
  const { ctx, isLoading, error, isRefreshing, isStale, refetch } = useWealth()
  const [target, setTarget] = useState<string>(() => localStorage.getItem(SATS_TARGET_KEY) ?? '')

  const reserves = useMemo(() => (ctx ? btcReserves(ctx) : null), [ctx])

  if (isLoading) return <WealthPageSkeleton />
  if (error) return <WealthError detail={error.message} onRetry={refetch} />
  if (!reserves) return null

  const { usd, sats, components, locations } = reserves

  if (!(usd > 0)) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={Bitcoin}
          title="No bitcoin exposure"
          description="BTC, and wrappers like WBTC, cbBTC or tBTC, appear here once a watched wallet holds them — LP legs and bot baskets included."
        />
      </div>
    )
  }

  const parsedTarget = Number(target.replace(/[,\s_]/g, ''))
  const chosen = Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : null
  // A target already passed is not a goal; fall through to the next milestone up.
  const goal = sats !== null ? (chosen && chosen > sats ? chosen : nextSatsMilestone(sats)) : null
  const pct = sats !== null && goal ? Math.min(100, (sats / goal) * 100) : 0
  const remaining = sats !== null && goal ? Math.max(0, goal - sats) : null

  const btcPrice = ctx?.data.rates?.btc_usd ?? null
  const whole = btcPrice ? usd / btcPrice : null

  return (
    <div className="space-y-4">
      {isStale && ctx && <StaleBanner age={formatRelativeTime(ctx.data.fetched_at)} onRefresh={refetch} refreshing={isRefreshing} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Reserves"
          accent
          value={<span className="text-amber-600 dark:text-amber-500">{formatSats(sats)}</span>}
          hint={sats === null ? 'no BTC price available — sats cannot be derived' : 'sats'}
        />
        <StatCard
          label="Value"
          value={formatUsd(usd)}
          hint={whole !== null ? `${whole.toFixed(4)} ₿` : 'BTC price unavailable'}
        />
        <StatCard
          label="Held as"
          value={`${components.length} asset${components.length === 1 ? '' : 's'}`}
          hint={components.map((c) => c.symbol).join(' · ')}
        />
      </div>

      {sats !== null && goal !== null && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Next milestone</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Progress value={pct} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm tabular-nums">
              <span className="text-muted-foreground">
                {pct.toFixed(0)}% of {formatSats(goal)} sats
              </span>
              <span className="text-muted-foreground">
                {formatSats(remaining)} sats to go
              </span>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Label htmlFor="sats-target" className="text-xs text-muted-foreground">
                Custom target
              </Label>
              <Input
                id="sats-target"
                inputMode="numeric"
                placeholder={String(nextSatsMilestone(sats))}
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value)
                  const raw = e.target.value.trim()
                  if (raw) localStorage.setItem(SATS_TARGET_KEY, raw)
                  else localStorage.removeItem(SATS_TARGET_KEY)
                }}
                className="h-8 max-w-40 tabular-nums"
              />
              <span className="text-xs text-muted-foreground">sats</span>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Custody</CardTitle>
            <p className="text-xs text-muted-foreground">Where it is, and who can move it</p>
          </CardHeader>
          <CardContent className="space-y-1">
            {locations.map((location) => {
              const custody = CUSTODY[location.kind]
              const Icon = custody.icon
              const share = usd > 0 ? (location.usd / usd) * 100 : 0
              return (
                <div key={location.label} className="flex items-center gap-3 rounded-md px-1 py-2">
                  <Icon className={cn('size-4 shrink-0', custody.tone)} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{location.label}</p>
                    <p className="text-xs text-muted-foreground">{custody.note}</p>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <p className="text-sm font-medium">{formatUsd(location.usd)}</p>
                    <p className="text-xs text-muted-foreground">{share.toFixed(0)}%</p>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Composition</CardTitle>
            <p className="text-xs text-muted-foreground">
              Which wrapper the exposure sits in — the total is the same either way
            </p>
          </CardHeader>
          <CardContent className="space-y-1">
            {components.map((component) => {
              const share = usd > 0 ? (component.usd / usd) * 100 : 0
              return (
                <div key={component.symbol} className="flex items-center gap-3 rounded-md px-1 py-2">
                  <Bitcoin className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{component.symbol}</p>
                  <div className="shrink-0 text-right tabular-nums">
                    <p className="text-sm font-medium">{formatUsd(component.usd)}</p>
                    <p className="text-xs text-muted-foreground">
                      {btcPrice ? `${formatSats((component.usd * 1e8) / btcPrice)} sats` : `${share.toFixed(0)}%`}
                    </p>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
