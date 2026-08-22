/**
 * Lending and liquidation health.
 *
 * Collateral here is already counted as spot aTokens/cTokens, so this panel does not add value —
 * it explains the debt that net worth subtracts, and how close that debt is to liquidating you.
 *
 * Hides itself entirely when there are no lending positions, so it costs nothing on a wallet that
 * does not borrow.
 */

import { ArrowDownRight, ArrowUpRight, Shield, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useMoney } from './money'
import { lendingPositions } from './derive'
import { formatAmount } from './format'
import type { Ctx } from './derive'
import type { LendRow, TokenAmt } from './types'
import { StatCard } from './wealth-ui'

/**
 * Health-factor bands. HF = collateral × liquidation threshold ÷ debt; you are liquidated below 1.
 *
 * The same thresholds gate the Telegram alert in `lyra-alerts`, so the colour on screen and the
 * message on your phone agree about what "at risk" means.
 */
export const HF_SAFE = 1.5
export const HF_WARN = 1.2

export function hfTone(hf: number | null): { text: string; bar: string; label: string } {
  if (hf === null) return { text: 'text-muted-foreground', bar: 'bg-muted-foreground/40', label: 'no debt' }
  if (hf >= HF_SAFE) return { text: 'text-emerald-600 dark:text-emerald-500', bar: 'bg-emerald-500', label: 'healthy' }
  if (hf >= HF_WARN) return { text: 'text-amber-600 dark:text-amber-500', bar: 'bg-amber-500', label: 'watch' }
  if (hf >= 1) return { text: 'text-red-600 dark:text-red-500', bar: 'bg-red-500', label: 'at risk' }
  return { text: 'text-red-600 dark:text-red-500', bar: 'bg-red-500', label: 'liquidatable' }
}

/** How far collateral can fall before HF hits 1. Zero once there is no room left. */
function buffer(hf: number | null): number {
  return hf === null || hf <= 1 ? 0 : 1 - 1 / hf
}

/** One supplied or borrowed leg — the actual asset, not just a dollar figure. */
function Leg({ token }: { token: TokenAmt }) {
  const borrowed = token.side === 'borrow'
  const Icon = borrowed ? ArrowDownRight : ArrowUpRight
  return (
    <span
      title={borrowed ? 'borrowed' : 'supplied'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs tabular-nums',
        borrowed
          ? 'border-red-500/20 bg-red-500/5 text-red-600 dark:text-red-500'
          : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600 dark:text-emerald-500',
      )}
    >
      <Icon className="size-3 shrink-0 opacity-70" />
      <span className="font-medium">{token.symbol}</span>
      <span className="text-muted-foreground">{formatAmount(token.amount)}</span>
    </span>
  )
}

function HealthRow({ row }: { row: LendRow }) {
  const { money } = useMoney()
  const tone = hfTone(row.hf)
  const ltv = row.collateral_usd > 0 ? row.debt_usd / row.collateral_usd : 0
  const used = row.liq_threshold > 0 ? Math.min(1, ltv / row.liq_threshold) : 0
  const room = buffer(row.hf)
  const hasDebt = row.debt_usd >= 0.01

  return (
    <div className="border-t px-1 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0">
          <span className="text-sm font-medium">{row.protocol}</span>
          <span className="ml-1.5 text-xs text-muted-foreground">{row.chain}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {row.tokens.length ? (
            row.tokens.map((token, i) => <Leg key={`${token.symbol}-${i}`} token={token} />)
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>
        <div className="ml-auto shrink-0 text-right">
          <div className="text-sm font-medium tabular-nums">{money(row.net_usd)}</div>
          <div className="mt-0.5 flex items-center justify-end gap-1 text-xs">
            <span className="text-muted-foreground">HF</span>
            <span className={cn('font-medium tabular-nums', tone.text)}>
              {row.hf === null ? '∞' : row.hf.toFixed(2)}
            </span>
            <span className={tone.text}>· {tone.label}</span>
          </div>
        </div>
      </div>

      {/* Only drawn when there is debt to be at risk over — an empty bar reads as a warning. */}
      {hasDebt && (
        <div className="mt-2.5">
          <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full rounded-full transition-all', tone.bar)} style={{ width: `${used * 100}%` }} />
            <div className="absolute inset-y-0 right-0 w-px bg-foreground/40" title="liquidation threshold" />
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 text-xs text-muted-foreground">
            <span>
              borrowed {money(row.debt_usd)} · LTV {(ltv * 100).toFixed(0)}% of {(row.liq_threshold * 100).toFixed(0)}% max
            </span>
            <span className={tone.text}>
              {room > 0 ? `${(room * 100).toFixed(0)}% price buffer` : 'no buffer'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export function BorrowingPanel({ ctx }: { ctx: Ctx }) {
  const { money } = useMoney()
  const rows = lendingPositions(ctx.data)
  if (!rows.length) return null

  const collateral = rows.reduce((sum, r) => sum + r.collateral_usd, 0)
  const debt = rows.reduce((sum, r) => sum + r.debt_usd, 0)
  // Only positions carrying actual debt have a health factor worth reporting.
  const withDebt = rows.filter((r) => r.hf !== null)
  const worst = withDebt.length ? Math.min(...withDebt.map((r) => r.hf as number)) : null
  const tone = hfTone(worst)
  const Icon = worst === null ? Shield : worst >= HF_SAFE ? ShieldCheck : ShieldAlert

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="text-base">Lending &amp; health</CardTitle>
          <p className="text-xs text-muted-foreground">Collateral, debt, and how much room is left</p>
        </div>
        <Icon className={cn('size-5 shrink-0', tone.text)} />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Supplied" value={money(collateral)} hint="collateral" />
          <StatCard label="Borrowed" value={money(debt)} hint="subtracted from net worth" />
          <StatCard
            label="Health factor"
            value={<span className={tone.text}>{worst === null ? '∞' : worst.toFixed(2)}</span>}
            hint={worst === null ? 'no active debt' : `lowest · ${tone.label}`}
          />
        </div>
        <div>
          {rows.map((row) => (
            <HealthRow key={row.key} row={row} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
