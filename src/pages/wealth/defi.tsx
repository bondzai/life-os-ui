/**
 * Wealth · DeFi — LP positions, whether they are earning, and what is claimable.
 *
 * Ordered by "needs attention" by default: an out-of-range position earns nothing while still
 * showing a healthy-looking balance, so surfacing it first is the entire point of the page.
 */

import { useMemo, useState } from 'react'
import { Layers, Search, Snowflake, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EmptyState } from '@/core/components/empty-state'
import { cn } from '@/lib/utils'
import {
  blendedApr,
  claimableByToken,
  claimableUsd,
  cyclePerf,
  earnings,
  lpPositions,
  rangeInfo,
  realizedPnl,
  sbLpId,
  sortLp,
  type ClaimableToken,
  type Ctx,
  type LpSortKey,
} from './derive'
import { useMoney } from './money'
import { formatAmount, formatDuration, formatPct, formatRelativeTime } from './format'
import { chainLabel } from './identity'
import { ChainMark, ChainTag, TokenMark, TokenPairMark } from './marks'
import { BorrowingPanel } from './borrowing'
import { HarvestPanel } from './cashflow'
import { SnowballToggle } from './snowball'
import { useSnowball, useSnowballTags } from './use-snowball'
import { RowsSkeleton, StaleBanner, WealthError } from './states'
import type { LpRow } from './types'
import { useWealth } from './use-wealth'
import { ChangeText, MetaPill, Pnl, RangeBadge, RangeBar, StatCard } from './wealth-ui'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const ALL = 'all'

export function WealthDefiPage() {
  const { money, compact } = useMoney()
  const { ctx, isLoading, error, isEmpty, isRefreshing, isStale, refetch } = useWealth()

  const [query, setQuery] = useState('')
  const [chain, setChain] = useState<string>(ALL)
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const [sortKey, setSortKey] = useState<LpSortKey>('health')

  const all = useMemo(() => (ctx ? lpPositions(ctx.data) : []), [ctx])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = all.filter((r) => {
      if (chain !== ALL && r.chain !== chain) return false
      if (status === 'active' && r.in_range === false) return false
      if (status === 'inactive' && r.in_range !== false) return false
      if (q && !`${r.pair} ${r.protocol} ${r.chain}`.toLowerCase().includes(q)) return false
      return true
    })
    return sortLp(filtered, sortKey, 'desc')
  }, [all, chain, status, query, sortKey])

  const summary = useMemo(() => {
    const value = rows.reduce((sum, r) => sum + r.value, 0)
    const perDay = rows.reduce((sum, r) => sum + (earnings(r)?.perDay ?? 0), 0)
    return {
      value,
      claimable: claimableUsd(rows),
      byToken: claimableByToken(rows),
      apr: blendedApr(rows),
      perDay,
      pnl: realizedPnl(rows),
      outOfRange: rows.filter((r) => r.in_range === false).length,
    }
  }, [rows])

  const chains = useMemo(() => [...new Set(all.map((r) => r.chain))].sort(), [all])
  const hasFilters = query !== '' || chain !== ALL || status !== 'all'
  const clearFilters = () => {
    setQuery('')
    setChain(ALL)
    setStatus('all')
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <RowsSkeleton rows={5} />
        </CardContent>
      </Card>
    )
  }

  if (error) return <WealthError detail={error.message} onRetry={refetch} retrying={isRefreshing} />

  if (isEmpty || !ctx) {
    return <EmptyState icon={Layers} title="No wallets connected" description="Connect a wallet to track LP positions." />
  }

  if (all.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        title="No DeFi positions"
        description="Liquidity positions and farms will appear here once you open one."
      />
    )
  }

  return (
    <div className="space-y-4">
      {isStale && (
        <StaleBanner age={formatRelativeTime(ctx.data.fetched_at)} onRefresh={refetch} refreshing={isRefreshing} />
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Position value" accent value={compact(summary.value)} hint={`${rows.length} position${rows.length === 1 ? '' : 's'}`} />
        <StatCard
          label="Net PnL"
          value={summary.pnl.covered > 0 ? <Pnl usd={summary.pnl.usd} /> : '—'}
          // Says which positions the total is over, because it is rarely all of them: vfat
          // accounts for NFT positions held through a Sickle, and nothing else on this page.
          hint={
            summary.pnl.covered === 0
              ? 'not reported for these positions'
              : summary.pnl.covered === rows.length
                ? 'since each position opened'
                : `since opening · ${summary.pnl.covered} of ${rows.length} positions`
          }
        />
        <StatCard
          label="Claimable"
          value={money(summary.claimable)}
          hint={summary.byToken.length > 0 ? summary.byToken.slice(0, 3).map((t) => t.symbol).join(' · ') : 'nothing to collect'}
        />
        <StatCard
          label="Blended APR"
          value={summary.apr !== null ? `${summary.apr.toFixed(1)}%` : '—'}
          hint={summary.perDay > 0 ? `≈ ${money(summary.perDay)}/day` : 'no APR reported'}
        />
        <StatCard
          label="Out of range"
          value={summary.outOfRange}
          hint={summary.outOfRange > 0 ? 'not earning fees' : 'all positions earning'}
        />
      </div>

      {/* Two panels that answer different questions about the same book — what a harvest pays out,
          and what is set aside to compound. Side by side on a wide screen; whichever one has
          something to say takes the full width when the other does not. */}
      <div className={cn('grid items-start gap-3', summary.byToken.length > 0 && 'lg:grid-cols-2')}>
        {summary.byToken.length > 0 && (
          <ClaimablePanel tokens={summary.byToken} total={summary.claimable} />
        )}
        <SnowballCard ctx={ctx} rows={all} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search pair or protocol…" className="pl-8" />
        </div>

        <Select value={chain} onValueChange={setChain}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Chain" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All chains</SelectItem>
            {chains.map((c) => (
              <SelectItem key={c} value={c}>
                <ChainMark chain={c} />
                {chainLabel(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">In range</SelectItem>
            <SelectItem value="inactive">Out of range</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sortKey} onValueChange={(v) => setSortKey(v as LpSortKey)}>
          <SelectTrigger className="w-[150px]"><SelectValue placeholder="Sort" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="health">Needs attention</SelectItem>
            <SelectItem value="value">Value</SelectItem>
            <SelectItem value="fees">Claimable</SelectItem>
            <SelectItem value="apr">APR</SelectItem>
            <SelectItem value="pnl">PnL</SelectItem>
            <SelectItem value="updated">Last action</SelectItem>
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 size-3.5" /> Clear
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">No positions match these filters</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>Clear filters</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <PositionTable rows={rows} />
          <div className="space-y-3 sm:hidden">
            {rows.map((row) => <PositionCard key={row.key} row={row} />)}
          </div>
        </>
      )}

      {/* What the positions above pay out, and the debt taken against them. Both self-hide. */}
      <HarvestPanel ctx={ctx} />
      <BorrowingPanel ctx={ctx} />
    </div>
  )
}

/**
 * The positions table — one row per position, the way the original showed them.
 *
 * Cards were the original's *mobile* layout; on a desktop it was this table, and rendering the
 * card everywhere is what turned six positions into two and a half screens. A book is a ledger:
 * the comparison you make constantly is one position against another, and that only works when
 * they share a row and columns line up.
 *
 * Everything the card carried is still here — the card keeps it below `sm`, and the two details
 * that do not fit a cell (per-token fee and underlying breakdowns) hang off `title` attributes.
 */
/**
 * A position's on-chain id, displayed.
 *
 * The engine hands these over **already carrying a `#`** (`"#73130974"`), inherited from the
 * Python. Prefixing another one rendered every position as `##73130974`. Normalised here rather
 * than at the two call sites, and tolerant of an id that arrives without one.
 */
function positionId(id: string): string {
  return `#${id.replace(/^#+/, '')}`
}

/**
 * What the PnL cell means, on hover.
 *
 * Worth spelling out because two plausible readings are both wrong: it is not the 24h move, and it
 * is not the claimable balance in the next column. It is the whole life of the position, fees and
 * rewards and price action together, against what was put in.
 */
function pnlTitle(row: LpRow): string | undefined {
  if (row.pnlUsd === null) return 'vfat does not report performance for this position'
  const since = row.deployedAt ? ` · opened ${new Date(row.deployedAt).toLocaleDateString()}` : ''
  return `Value now, less everything paid in, since the position opened${since}`
}

function PositionTable({ rows }: { rows: LpRow[] }) {
  const { money } = useMoney()

  return (
    <div className="hidden overflow-x-auto rounded-lg border sm:block">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Position</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead>Protocol</TableHead>
            <TableHead className="min-w-[9rem]">Range</TableHead>
            <TableHead className="text-right">Deposit</TableHead>
            <TableHead className="text-right">PnL</TableHead>
            <TableHead className="text-right">Daily</TableHead>
            <TableHead className="text-right">Earned</TableHead>
            <TableHead className="text-right">APR</TableHead>
            <TableHead>Last action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const range = rangeInfo(row)
            const daily = earnings(row)
            const perf = cyclePerf(row)
            const out = row.in_range === false
            // The two lists the card showed in full. A row cannot hold them, and dropping them
            // would lose the only place the per-token split is visible.
            const feeTitle = row.feeToks.map((t) => `${formatAmount(t.amount)} ${t.symbol}`).join(' · ')
            const posTitle = row.toks.map((t) => `${formatAmount(t.amount)} ${t.symbol}`).join(' · ')

            return (
              <TableRow key={row.key} className={cn(out && 'bg-destructive/5')}>
                <TableCell className="whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <SnowballToggle id={sbLpId(row.key)} name={row.pair} />
                    <TokenPairMark tokens={row.toks} />
                    <span className="font-medium" title={posTitle || undefined}>{row.pair}</span>
                    <RangeBadge inRange={row.in_range} full={row.band?.full} />
                    {row.poolType && <MetaPill>{row.poolType}</MetaPill>}
                  </div>
                </TableCell>
                <TableCell><ChainTag chain={row.chain} /></TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {row.protocol}
                  {row.id && <span className="text-xs"> {positionId(row.id)}</span>}
                </TableCell>
                <TableCell>
                  {range ? (
                    <div className="space-y-1">
                      <RangeBar posPct={range.posPct} out={range.out} />
                      <div className="flex justify-between gap-2 text-xs whitespace-nowrap">
                        <span className={cn(range.out ? 'text-red-600 dark:text-red-500' : 'text-muted-foreground')}>
                          {range.edge}
                        </span>
                        <span className="text-muted-foreground">{range.width.toFixed(0)}% wide</span>
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">full range</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">{money(row.value)}</TableCell>
                {/* Lifetime, not this cycle — "Earned" beside it is what is still claimable. The
                    percentage is vfat's own return on contributions, so it is shown rather than
                    left to be eyeballed against the deposit, which is a different denominator. */}
                <TableCell className="text-right whitespace-nowrap" title={pnlTitle(row)}>
                  <Pnl usd={row.pnlUsd} />
                  {row.pnlPct !== null && (
                    <div className="text-xs">
                      <ChangeText value={row.pnlPct} />
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {daily ? `≈${money(daily.perDay)}` : '—'}
                </TableCell>
                <TableCell
                  className="text-right tabular-nums"
                  title={feeTitle || undefined}
                >
                  {row.fees > 0 ? money(row.fees) : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.apr !== null ? formatPct(row.apr, 1) : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {row.lastAction && row.updatedAt ? (
                    <>
                      {row.lastAction} {formatRelativeTime(Date.parse(row.updatedAt) / 1000)}
                    </>
                  ) : (
                    '—'
                  )}
                  {/* In-range time is the number that tells you whether a band is working, so it
                      stays visible rather than moving into a tooltip. */}
                  {perf?.pct !== null && perf !== null && (
                    <div className="text-xs">in range {perf.pct.toFixed(0)}% this cycle</div>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * One position as a card. **Below `sm` only** — see [[PositionTable]] for why.
 */
function PositionCard({ row }: { row: LpRow }) {
  const { money } = useMoney()
  const range = rangeInfo(row)
  const perf = cyclePerf(row)
  const daily = earnings(row)
  const out = row.in_range === false

  return (
    <Card className={cn(out && 'border-destructive/40')}>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <TokenPairMark tokens={row.toks} />
              <h3 className="font-medium">{row.pair}</h3>
              <RangeBadge inRange={row.in_range} full={row.band?.full} />
              {row.poolType && <MetaPill>{row.poolType}</MetaPill>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{row.protocol}</span>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <ChainMark chain={row.chain} />
                {chainLabel(row.chain)}
              </span>
              {row.id && <><span>·</span><span>{positionId(row.id)}</span></>}
              {row.lastAction && row.updatedAt && (
                <>
                  <span>·</span>
                  <span>{row.lastAction} {formatRelativeTime(Date.parse(row.updatedAt) / 1000)}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-start gap-1">
            <SnowballToggle id={sbLpId(row.key)} name={row.pair} className="mt-0.5" />
            <div className="text-right">
              <div className="font-semibold tabular-nums">{money(row.value)}</div>
              <div className="text-xs text-muted-foreground">
                {row.apr !== null ? <>{formatPct(row.apr, 1)} APR</> : 'APR n/a'}
                {daily && <> · ≈{money(daily.perDay)}/day</>}
              </div>
              {row.pnlUsd !== null && (
                <div className="text-xs" title={pnlTitle(row)}>
                  <Pnl usd={row.pnlUsd} />
                  {row.pnlPct !== null && <> · <ChangeText value={row.pnlPct} /></>}
                </div>
              )}
            </div>
          </div>
        </div>

        {range && (
          <div className="space-y-1">
            <RangeBar posPct={range.posPct} out={range.out} />
            <div className="flex flex-wrap justify-between gap-2 text-xs">
              <span className={cn(range.out ? 'text-red-600 dark:text-red-500' : 'text-muted-foreground')}>
                {range.edge}
              </span>
              <span className="text-muted-foreground">band {range.width.toFixed(1)}% wide</span>
            </div>
          </div>
        )}

        <div className="grid gap-3 border-t pt-3 sm:grid-cols-3">
          <Metric label="Claimable" value={money(row.fees)}>
            {row.feeToks.length > 0 && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {row.feeToks.map((t) => `${formatAmount(t.amount)} ${t.symbol}`).join(' · ')}
              </p>
            )}
          </Metric>

          <Metric label="Position" value={row.toks.map((t) => t.symbol).join(' / ') || '—'}>
            {row.toks.length > 0 && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {row.toks.map((t) => formatAmount(t.amount)).join(' · ')}
              </p>
            )}
          </Metric>

          {perf ? (
            <Metric
              label={`In range since ${perf.anchor}`}
              value={perf.pct !== null ? `${perf.pct.toFixed(0)}%` : '—'}
            >
              <p className="mt-0.5 text-xs text-muted-foreground">
                {perf.inRangeSecs !== null ? formatDuration(perf.inRangeSecs) : 'not tracked'} of{' '}
                {formatDuration(perf.elapsedSecs)}
              </p>
            </Metric>
          ) : (
            <Metric label="24h" value={<ChangeText value={null} />} />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Metric({ label, value, children }: { label: string; value: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-0.5 font-medium tabular-nums">{value}</p>
      {children}
    </div>
  )
}

/**
 * Claimable by token — what a harvest of everything would actually hand you.
 *
 * It used to be a wrapping row of equal-weight pills, which answered none of that: seven identical
 * chips gave no sense of which one mattered, the amount was the biggest text when the *value* is
 * what you compare, and a wrapped-BTC balance rendered as `9.06e-6`, so the top row by value was
 * the least readable thing on the card.
 *
 * A ranked list instead, each row filled to its share of the total. Length is the only variable —
 * one fill colour, not seven brand tints — so "one token is most of this and the rest is dust"
 * lands before any number is read. The fill is share of *total*, not of the largest, because that
 * is the honest proportion: a sliver should look like a sliver.
 */
function ClaimablePanel({ tokens, total }: { tokens: ClaimableToken[]; total: number }) {
  const { money } = useMoney()

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-start justify-between gap-2 px-4 py-3">
        <div>
          <CardTitle className="text-sm font-medium">Claimable by token</CardTitle>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            What harvesting everything would pay out. Wallet-level campaign claims are counted once,
            not once per position.
          </p>
        </div>
        <span className="shrink-0 text-lg font-semibold tabular-nums">{money(total)}</span>
      </CardHeader>
      <CardContent className="px-4 pt-0 pb-3">
        <ul className="grid gap-1 sm:grid-cols-2 sm:gap-x-3">
          {tokens.map((t) => (
            <li key={t.symbol} className="relative overflow-hidden rounded-md">
              {/* Behind the label rather than beside it: a separate bar column would cost width the
                  amount needs, and the row is only 28px tall. */}
              <div
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-md bg-primary/15"
                style={{ width: `${total > 0 ? Math.max((t.usd / total) * 100, 1.5) : 0}%` }}
              />
              <div className="relative flex items-center gap-2 px-1.5 py-1">
                <TokenMark symbol={t.symbol} />
                <span className="text-sm font-medium">{t.symbol}</span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {formatAmount(t.amount)}
                </span>
                <span className="w-20 shrink-0 text-right text-sm font-medium tabular-nums">
                  {money(t.usd)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/**
 * The snowball, as it looks from this page.
 *
 * The full panel — chart, picker, projection — lives on Overview. What belongs *here* is the
 * question this page can act on, because the ❄ button is on every row of the table below: how much
 * of the basket is LP, and how much of the LP book is in it.
 *
 * Deliberately reads the whole LP book, not the filtered rows. A total that shrinks when you filter
 * by chain is not a total.
 */
function SnowballCard({ ctx, rows }: { ctx: Ctx; rows: LpRow[] }) {
  const { money } = useMoney()
  const { total, weekDelta } = useSnowball(ctx)
  const { isTagged } = useSnowballTags()

  const here = useMemo(() => {
    const tagged = rows.filter((r) => isTagged(sbLpId(r.key)))
    return { usd: tagged.reduce((sum, r) => sum + r.value, 0), count: tagged.length }
  }, [rows, isTagged])

  const share = total > 0 ? Math.min((here.usd / total) * 100, 100) : 0
  // Clamped at zero: the basket total and this page's slice are summed from the same members, but
  // a stale render between them should show nothing rather than a negative remainder.
  const elsewhere = Math.max(total - here.usd, 0)

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-start justify-between gap-2 px-4 py-3">
        <div>
          <CardTitle className="flex items-center gap-1.5 text-sm font-medium">
            <Snowflake className={cn('size-3.5', here.count > 0 ? 'text-sky-500' : 'text-muted-foreground')} />
            Snowball
          </CardTitle>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            The slice you tagged to compound, across the whole book.
          </p>
        </div>
        <div className="shrink-0 text-right">
          {/* No em dash on an empty basket. Elsewhere "—" means a number we could not read; here
              there is simply nothing tagged yet, and the body says so in words. */}
          {total > 0 && <div className="text-lg font-semibold tabular-nums">{money(total)}</div>}
          {weekDelta !== null && weekDelta !== 0 && (
            <div
              className={cn(
                'text-[11px] font-medium tabular-nums',
                weekDelta > 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-red-600 dark:text-red-500',
              )}
            >
              {weekDelta > 0 ? '+' : '−'}
              {money(Math.abs(weekDelta))} this week
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="px-4 pt-0 pb-3">
        {here.count === 0 ? (
          // Not hidden when empty: the ❄ that fills this is on every row of the table below, so
          // the nudge is one line away from the thing it is asking for.
          <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            No LP position is tagged yet — press
            <Snowflake className="size-3.5" aria-hidden />
            on a row below to start compounding one.
          </p>
        ) : (
          <div className="space-y-2">
            {/* Two segments, and the second one is the point: a bar that is 100% full says nothing
                on its own. Naming what the remainder is turns it into "all of my snowball is LP",
                which is a fact worth knowing. */}
            <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="bg-sky-500" style={{ width: `${share}%` }} />
            </div>
            <dl className="space-y-1 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-2 shrink-0 rounded-full bg-sky-500" aria-hidden />
                  LP here · {here.count} of {rows.length} position{rows.length === 1 ? '' : 's'}
                </dt>
                <dd className="font-medium tabular-nums">{money(here.usd)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-2 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden />
                  {elsewhere > 0.005 ? 'Wallets, bots and off-chain' : 'Nothing tagged outside this page'}
                </dt>
                {/* `$0.00` and not an em dash: the dash is this app's "we could not read this",
                    and an empty remainder is a number we know exactly. */}
                <dd className="tabular-nums text-muted-foreground">{money(elsewhere)}</dd>
              </div>
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
