/**
 * Wealth · DeFi — LP positions, whether they are earning, and what is claimable.
 *
 * Ordered by "needs attention" by default: an out-of-range position earns nothing while still
 * showing a healthy-looking balance, so surfacing it first is the entire point of the page.
 */

import { useMemo, useState } from 'react'
import { Expand, Landmark, Layers, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
  lendingPositions,
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
import { formatAmount, formatDuration, formatRelativeTime } from './format'
import { chainLabel } from './identity'
import { hfTone, HF_SAFE } from './borrowing'
import { SnowballPanel, SnowballToggle } from './snowball'
import { useSnowball, useSnowballTags } from './use-snowball'
import { StaleBanner, WealthError } from './states'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { LendRow, LpRow, TokenAmt } from './types'
import { useWealth } from './use-wealth'
import { ChangeText, Pnl, PoolTypeMark, RangeBadge, RangeBar } from './wealth-ui'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const ALL = 'all'

/** Below this, a position is not worth the gas to harvest — the same floor the old panel used. */
const MIN_HARVEST_USD = 1

export function WealthDefiPage() {
  const { ctx, isLoading, error, isEmpty, isRefreshing, isStale, refetch } = useWealth()

  const [query, setQuery] = useState('')
  const [chain, setChain] = useState<string>(ALL)
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const [sortKey, setSortKey] = useState<LpSortKey>('health')

  const all = useMemo(() => (ctx ? lpPositions(ctx.data) : []), [ctx])
  const lendAll = useMemo(() => (ctx ? lendingPositions(ctx.data) : []), [ctx])

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

  /**
   * The same filters, applied to the lending book.
   *
   * These share the table below rather than living in a panel of their own. A borrow is a position:
   * it has a venue, a value, and a number that says how close it is to going wrong — the same three
   * questions the LP rows answer, in the same three columns. Splitting them across two surfaces
   * meant the one row on the page that can liquidate you was the one row you had to scroll for.
   *
   * Sorted worst-health-first and always last in the table, so the ledger stays sorted by whatever
   * the LP sort says while the borrow that needs attention is still the first lending row.
   */
  const lendRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    // In range / out of range is a question about a price band, and a loan does not have one.
    // Rather than answer it wrongly, lending steps aside whenever that filter is applied.
    if (status !== 'all') return []
    return lendAll
      .filter((r) => {
        if (chain !== ALL && r.chain !== chain) return false
        const haystack = `${r.protocol} ${r.chain} ${r.tokens.map((t) => t.symbol).join(' ')}`
        if (q && !haystack.toLowerCase().includes(q)) return false
        return true
      })
      .sort((a, b) => (a.hf ?? Number.POSITIVE_INFINITY) - (b.hf ?? Number.POSITIVE_INFINITY))
  }, [lendAll, chain, status, query])

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
      // What a harvest would actually collect right now, and from how many positions. Unlike the
      // projected per-day figure this is not modelled — it is on-chain this second.
      harvest: rows.filter((r) => r.fees >= MIN_HARVEST_USD),
    }
  }, [rows])

  /**
   * Debt and the worst health factor across it.
   *
   * Deliberately read from the whole book rather than the filtered rows: liquidation does not care
   * which chain you are looking at, and a risk figure that disappears when you filter is worse
   * than no figure. The same reason `SnowballCard` reads `all`.
   */
  const lending = useMemo(() => {
    const rows = lendAll.filter((r) => r.debt_usd > 0)
    if (rows.length === 0) return null
    const withHf = rows.filter((r): r is LendRow & { hf: number } => r.hf !== null)
    return {
      debt: rows.reduce((sum, r) => sum + r.debt_usd, 0),
      // The worst one, because an average health factor is a number that cannot hurt you while
      // one position underneath it is being liquidated.
      worstHf: withHf.length > 0 ? Math.min(...withHf.map((r) => r.hf)) : null,
      count: rows.length,
    }
  }, [lendAll])

  const chains = useMemo(
    () => [...new Set([...all, ...lendAll].map((r) => r.chain))].sort(),
    [all, lendAll],
  )
  const hasFilters = query !== '' || chain !== ALL || status !== 'all'
  const clearFilters = () => {
    setQuery('')
    setChain(ALL)
    setStatus('all')
  }

  /**
   * The page is drawn immediately and filled in, rather than replaced by a skeleton and then
   * swapped for something shaped differently.
   *
   * A skeleton *instead of* the page means the first thing you see is discarded: the bar, the
   * filters and the column headers all arrive at once, half a second later, and everything moves.
   * A skeleton *inside* the page means the structure is there from the first frame and only the
   * numbers arrive late — nothing reflows, and the filters are usable before the data lands.
   */
  const loading = isLoading || !ctx

  // Error and empty are terminal, not transitional: they replace the page because there is
  // nothing to fill in. Both wait for loading to finish so neither can flash during it.
  if (error) return <WealthError detail={error.message} onRetry={refetch} retrying={isRefreshing} />

  if (!loading && isEmpty) {
    return <EmptyState icon={Layers} title="No wallets connected" description="Connect a wallet to track LP positions." />
  }

  if (!loading && all.length === 0 && lendAll.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        title="No DeFi positions"
        description="Liquidity positions, farms and loans will appear here once you open one."
      />
    )
  }

  return (
    <div className="space-y-4">
      {isStale && ctx && (
        <StaleBanner age={formatRelativeTime(ctx.data.fetched_at)} onRefresh={refetch} refreshing={isRefreshing} />
      )}

      <SummaryBar
        summary={summary}
        count={rows.length}
        total={all.length}
        lendCount={lendRows.length}
        lending={lending}
        loading={loading}
        ctx={ctx}
        rows={all}
        outOfRangeActive={status === 'inactive'}
        onToggleOutOfRange={() => setStatus(status === 'inactive' ? 'all' : 'inactive')}
      />

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

      {loading ? (
        <PositionTable rows={[]} lend={[]} loading />
      ) : rows.length === 0 && lendRows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">No positions match these filters</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>Clear filters</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <PositionTable rows={rows} lend={lendRows} />
          <div className="space-y-3 sm:hidden">
            {rows.map((row) => <PositionCard key={row.key} row={row} />)}
            {lendRows.map((row) => <LendCard key={row.key} row={row} />)}
          </div>
        </>
      )}

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
 * The book in one line: one figure to read first, four to compare against it.
 *
 * This was five equal stat cards, which gave five numbers the same weight and left the eye no
 * entry point — and at `lg` they wrapped 3 + 2, so the row was visibly ragged on exactly the
 * screen most of this is read on. One primary figure with the rest set inline is two levels of
 * emphasis instead of one, and it costs about a third of the height.
 *
 * Out of range is the only one that is a *state* rather than a quantity, so it doubles as the
 * filter for itself — the number you want to act on is one click from the number that told you to.
 * It stays plain text rather than a badge: the badges on the rows below are load-bearing, and a
 * sixth one up here would dilute what they mean.
 */
function SummaryBar({
  summary,
  count,
  total,
  lendCount,
  lending,
  loading,
  ctx,
  rows,
  outOfRangeActive,
  onToggleOutOfRange,
}: {
  summary: {
    value: number
    claimable: number
    byToken: ClaimableToken[]
    apr: number | null
    perDay: number
    harvest: LpRow[]
    pnl: { usd: number; covered: number }
    outOfRange: number
  }
  /** Positions after filtering — what every figure here is computed over. */
  count: number
  /** Positions before filtering, so the bar can say when it is showing a subset. */
  total: number
  /** Lending rows currently in the table, so the count line matches what is on screen. */
  lendCount: number
  /** Debt and its worst health factor, or `null` on a book that does not borrow. */
  lending: { debt: number; worstHf: number | null; count: number } | null
  /** The first fetch has not landed. Figures draw placeholders instead of inventing zeros. */
  loading: boolean
  /** For the snowball line, which reads the whole book rather than the filtered rows. */
  ctx: Ctx | null
  rows: LpRow[]
  outOfRangeActive: boolean
  onToggleOutOfRange: () => void
}) {
  const { money, compact } = useMoney()

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-4 py-4">
        <div className="min-w-[8rem]">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Position value</p>
          {loading ? (
            <Skeleton className="my-1 h-7 w-28" />
          ) : (
            <p className="text-2xl leading-tight font-semibold tabular-nums">
              {compact(summary.value)}
            </p>
          )}
          {/* Every figure on this bar is computed over the *filtered* rows, so the headline drops
              when you narrow the table. That is the right behaviour — a summary of what you are
              looking at — but only if it admits it. "3 of 7 positions" is the whole disclosure. */}
          {/* The table below holds two kinds of row and this figure only covers one of them —
              collateral is already counted as spot holdings, so folding a loan into "position
              value" would count it twice. Naming both counts is what keeps the headline and the
              row count from looking like they disagree. */}
          <p className={cn('text-xs text-muted-foreground', loading && 'invisible')}>
            {count === total
              ? `${count} position${count === 1 ? '' : 's'}`
              : `${count} of ${total} positions`}
            {lendCount > 0 && ` · ${lendCount} lending`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <Figure
            loading={loading}
            label="Net PnL"
            value={summary.pnl.covered > 0 ? <Pnl usd={summary.pnl.usd} /> : '—'}
            // Says which positions the total is over, because it is rarely all of them: vfat
            // accounts for NFT positions held through a Sickle, and nothing else on this page.
            hint={
              summary.pnl.covered === 0
                ? 'not reported'
                : summary.pnl.covered === count
                  ? 'since opening'
                  : `${summary.pnl.covered} of ${count} positions`
            }
          />
          {/* The per-token split used to be a card below the table — a second place to look for
              the same money, on a page whose whole redesign was about fitting in one screen. It
              is the detail behind this figure, so it hangs off this figure. Nothing to collect
              means nothing to open, and it stays a plain figure. */}
          {!loading && summary.byToken.length > 0 ? (
            <FigureDialog
              label="Claimable"
              value={money(summary.claimable)}
              hint={summary.byToken.slice(0, 3).map((t) => t.symbol).join(' · ')}
              title="Claimable by token"
              description="What harvesting everything would pay out. Wallet-level campaign claims are counted once, not once per position."
            >
              <ClaimableBreakdown tokens={summary.byToken} total={summary.claimable} />
            </FigureDialog>
          ) : (
            <Figure
              loading={loading}
              label="Claimable"
              value={money(summary.claimable)}
              hint="nothing to collect"
            />
          )}
          <Figure
            loading={loading}
            label="Ready to harvest"
            value={
              summary.harvest.length > 0
                ? money(summary.harvest.reduce((sum, r) => sum + r.fees, 0))
                : '—'
            }
            hint={
              summary.harvest.length > 0
                ? `${summary.harvest.length} position${summary.harvest.length === 1 ? '' : 's'} above ${money(MIN_HARVEST_USD)}`
                : 'nothing worth the gas'
            }
          />
          <Figure
            loading={loading}
            label="Blended APR"
            value={rate(summary.apr) ?? '—'}
            hint="advertised, not realised"
          />
          {/* Modelled from each position's own APR — one reporting none contributes nothing, so
              this errs low rather than guessing. The figure beside it is what is actually on
              chain right now; these two must not be confused, hence the word "projected". */}
          <Figure
            loading={loading}
            label="Projected yield"
            value={summary.perDay > 0 ? `${money(summary.perDay)}/day` : '—'}
            hint={summary.perDay > 0 ? `≈ ${money(summary.perDay * 365)}/year` : 'no APR reported'}
          />

          {/* Debt and how close it is to liquidating you, from the whole book rather than the
              filtered rows. Absent entirely on a wallet that does not borrow — the panel this
              replaces self-hid for the same reason, and an empty "Debt —" is a row of nothing. */}
          {lending && (
            <Figure
              label="Borrowed"
              value={money(lending.debt)}
              hint={
                lending.worstHf === null
                  ? `${lending.count} position${lending.count === 1 ? '' : 's'} · health unknown`
                  : `health ${lending.worstHf.toFixed(2)} · ${hfTone(lending.worstHf).label}`
              }
              // Only when it is not healthy. A risk figure that is always coloured is decoration;
              // one that colours when the number moves is a warning.
              tone={
                lending.worstHf !== null && lending.worstHf < HF_SAFE
                  ? hfTone(lending.worstHf).text
                  : undefined
              }
            />
          )}

          <SnowballFigure ctx={ctx} rows={rows} loading={loading} />

          {summary.outOfRange > 0 ? (
            <button
              type="button"
              onClick={onToggleOutOfRange}
              aria-pressed={outOfRangeActive}
              className={cn(
                'rounded-md px-2 py-1 text-left transition-colors',
                'hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:outline-none',
                outOfRangeActive && 'bg-destructive/10',
              )}
            >
              <p className="text-xs tracking-wide text-muted-foreground uppercase">Out of range</p>
              <p className="font-medium tabular-nums text-red-700 dark:text-red-400">
                {summary.outOfRange}
              </p>
              <p className="text-xs text-muted-foreground">
                {outOfRangeActive ? 'showing only these' : 'not earning fees · filter'}
              </p>
            </button>
          ) : (
            <Figure label="Out of range" value="0" hint="all positions earning" />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Marks a value that is hiding something behind hover.
 *
 * Lifted from vfat, which underlines every figure carrying a tooltip with a dotted rule. The
 * problem it solves is not that tooltips are bad — it is that ours were *undiscoverable*: a
 * `title` gives no sign it exists, so the per-token fee split, the underlying amounts and the
 * whole meaning of the PnL column were sitting one hover away from someone with no reason to
 * hover. A dotted underline costs a pixel and turns a secret into an offer.
 *
 * `decoration-dotted underline-offset-4` and a muted rule, so it reads as an affordance rather
 * than as a link. Still invisible on touch — that is what a detail panel is for, and this is not
 * a substitute for one.
 */
const HAS_MORE = 'underline decoration-dotted decoration-muted-foreground/50 underline-offset-4'

/**
 * A summary figure that opens something bigger.
 *
 * The affordance is the whole point. A figure that *happens* to be clickable is indistinguishable
 * from the five beside it that are not: hover is undiscoverable, and on a touch screen it does not
 * exist at all. So the label carries a small expand glyph, and the same glyph marks every figure
 * that opens — "this label has a mark" reads as a rule rather than as two unrelated decorations.
 *
 * The negative margin cancels the button's own padding, so a figure that opens still lines up with
 * the ones that do not; the hit area grows without the row going ragged.
 */
function FigureDialog({
  label,
  value,
  hint,
  title,
  description,
  children,
}: {
  label: string
  value: React.ReactNode
  hint: string
  /** Dialog heading, when the panel inside is called something longer than the figure. */
  title?: string
  /** One line under the heading. Also what a screen reader announces for the dialog. */
  description?: string
  children: React.ReactNode
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`${label} — open details`}
          className={cn(
            '-mx-2 -my-1 rounded-md px-2 py-1 text-left transition-colors',
            'hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          )}
        >
          <p className="flex items-center gap-1 text-xs tracking-wide text-muted-foreground uppercase">
            {label}
            <Expand className="size-3 shrink-0 opacity-60" aria-hidden="true" />
          </p>
          <p className="font-medium tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title ?? label}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/** One secondary figure on the summary bar. Label, value, and the caveat the value needs. */
function Figure({
  label,
  value,
  hint,
  tone,
  loading,
}: {
  label: string
  value: React.ReactNode
  hint: string
  /** Text colour for a value that needs attention. Left off, the figure is just a figure. */
  tone?: string
  /**
   * Waiting on the fetch. Draws a bar the size of the number instead of the number.
   *
   * Not a zero and not an em dash: `$0.00` is a lie about someone's money and `—` is this
   * codebase's word for "we looked and could not read it". Neither is true while the request is
   * still in flight, and a placeholder that says "coming" is the honest third thing.
   */
  loading?: boolean
}) {
  return (
    <div>
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      {loading ? (
        <Skeleton className="my-[3px] h-4 w-20" />
      ) : (
        <p className={cn('font-medium tabular-nums', tone)}>{value}</p>
      )}
      {loading ? (
        <Skeleton className="my-[3px] h-2.5 w-24" />
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}

/**
 * A position's on-chain id.
 *
 * The engine hands these over **already carrying a `#`** (`"#73130974"`), inherited from the
 * Python. Prefixing another one rendered every position as `##73130974`. Normalised here rather
 * than at the call sites, and tolerant of an id that arrives without one.
 *
 * **Not rendered as text any more.** An NFT token id is not a fact about the position: you cannot
 * compare two positions by it, sort by it or judge anything from it, and it was taking a line in
 * the column you scan to answer "where is this". It survives in a `title` for the one job it has —
 * matching a row against an explorer — and the deep link carries it without anyone reading digits.
 */
function positionId(id: string): string {
  return `#${id.replace(/^#+/, '')}`
}

/**
 * Where a position lives, as one line of hover text.
 *
 * Carries the id that used to sit under the protocol, so nothing is lost — only moved out of the
 * way of the numbers you actually read.
 */
function venueTitle(row: LpRow): string | undefined {
  const parts = [chainLabel(row.chain), row.protocol].filter(Boolean)
  if (row.id) parts.push(positionId(row.id))
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * A yield rate, unsigned.
 *
 * [`formatPct`] prefixes `+` on anything positive, which is right for a *change* and wrong for a
 * rate: an APR of 12.4% rendered as "+12.4%" reads as a gain of twelve percent on something. It
 * also disagreed with the summary bar, which has always printed the blended figure plain. One
 * helper so the row and the headline cannot drift apart again.
 */
function rate(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return `${value.toFixed(1)}%`
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

/**
 * When a position last did something, or `null` if we cannot say.
 *
 * `Date.parse` returns `NaN` on anything it does not recognise, and the guard here used to be that
 * the field was *present* — which is a different question from whether it parses. A `NaN` fed to
 * `formatRelativeTime` renders as nonsense rather than as nothing.
 */
/**
 * Everything the compact range cell stops showing, as one line of hover text.
 *
 * The table used to spend three lines and nine rem on a bar, a distance-to-edge string and a
 * width — for a column whose job is answering "is this working?" at a glance. vfat gives it a
 * short bar and one number and puts the rest behind the bar. The numbers are still exact, they
 * are just no longer competing with the ones you came to read.
 */
function rangeTitle(range: { edge: string; width: number; out: boolean }): string {
  const state = range.out ? 'Out of range' : 'In range'
  return `${state} · ${range.edge} · band ${range.width.toFixed(1)}% wide`
}

function actionAge(row: LpRow): number | null {
  if (!row.lastAction || !row.updatedAt) return null
  const parsed = Date.parse(row.updatedAt)
  return Number.isFinite(parsed) ? parsed / 1000 : null
}

function PositionTable({
  rows,
  lend,
  loading,
}: {
  rows: LpRow[]
  /** Loans, rendered as rows of the same ledger — see [[LendTableRow]]. */
  lend: LendRow[]
  loading?: boolean
}) {
  const { money } = useMoney()

  return (
    <div className="hidden overflow-x-auto rounded-lg border sm:block">
      {/* Ten columns scrolled sideways on a laptop, and four of them answered two questions
          between them: *where* is this (chain, protocol) and *what does it pay* (APR, daily).
          Merged into one cell each, stacked, so the row is eight columns and fits. Cell padding
          is tightened here rather than in the shared table, which other surfaces rely on. */}
      <Table className="[&_td]:py-2 [&_th]:py-2">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Position</TableHead>
            <TableHead>Venue</TableHead>
            <TableHead>Range</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">PnL</TableHead>
            <TableHead className="text-right">Claimable</TableHead>
            <TableHead className="text-right">APR</TableHead>
            <TableHead>Activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* Placeholder rows inside the real table, so the header, the column widths and the
              border are all correct from the first frame and only the cells fill in. */}
          {loading &&
            Array.from({ length: 5 }, (_, i) => (
              <TableRow key={`skeleton-${i}`} className="hover:bg-transparent">
                {Array.from({ length: 8 }, (_, cell) => (
                  <TableCell key={cell}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {rows.map((row) => {
            const range = rangeInfo(row)
            const daily = earnings(row)
            const perf = cyclePerf(row)
            const age = actionAge(row)
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
                    <span className={cn('font-medium', posTitle && HAS_MORE)} title={posTitle || undefined}>
                      {row.pair}
                    </span>
                    <RangeBadge inRange={row.in_range} full={row.band?.full} />
                    {row.poolType && <PoolTypeMark type={row.poolType} />}
                  </div>
                </TableCell>
                {/* Where this position lives — chain and protocol were two columns asking one
                    question. The token id is in the title, not the cell: see [[positionId]]. */}
                <TableCell className="whitespace-nowrap" title={venueTitle(row)}>
                  <div>{chainLabel(row.chain)}</div>
                  <div className={cn('text-xs text-muted-foreground w-fit', HAS_MORE)}>
                    {row.protocol}
                  </div>
                </TableCell>
                {/* A bar and a number. The distance-to-edge string and the exact width moved into
                    the title — see [[rangeTitle]]. */}
                <TableCell title={range ? rangeTitle(range) : undefined}>
                  {range ? (
                    <div className="flex items-center gap-2">
                      <RangeBar posPct={range.posPct} out={range.out} className="w-14 shrink-0" />
                      <span className={cn('text-xs tabular-nums text-muted-foreground', HAS_MORE)}>
                        {range.width.toFixed(0)}%
                      </span>
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
                  <span className={cn(row.pnlUsd !== null && HAS_MORE)}>
                    <Pnl usd={row.pnlUsd} />
                  </span>
                  {row.pnlPct !== null && (
                    <div className="text-xs">
                      <ChangeText value={row.pnlPct} />
                    </div>
                  )}
                </TableCell>
                <TableCell
                  className="text-right tabular-nums"
                  title={feeTitle || undefined}
                >
                  {row.fees > 0 ? (
                    <span className={cn(feeTitle && HAS_MORE)}>{money(row.fees)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                {/* Rate and the money that rate implies, in one cell: the daily figure is derived
                    from the APR beside it, so two columns spent width restating one number. */}
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {rate(row.apr) ?? <span className="text-muted-foreground">—</span>}
                  {daily && (
                    <div className="text-xs text-muted-foreground">≈{money(daily.perDay)}/day</div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {age !== null ? (
                    <>
                      {row.lastAction} {formatRelativeTime(age)}
                    </>
                  ) : (
                    '—'
                  )}
                  {/* In-range time is the number that tells you whether a band is working, so it
                      stays visible rather than moving into a tooltip.

                      Order matters: this read `perf?.pct !== null && perf !== null`, which only
                      worked because the second test caught what the first let through — a null
                      `perf` makes `perf?.pct` undefined, and undefined is not null. */}
                  {perf !== null && perf.pct !== null && (
                    <div className="text-xs">in range {perf.pct.toFixed(0)}% this cycle</div>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
          {lend.map((row) => (
            <LendTableRow key={row.key} row={row} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * The legs of a loan, split by side and summarised as symbols.
 *
 * The exact amounts go in a `title`: a row has space for "what did I put in and what did I take
 * out", not for six token balances.
 */
function lendLegs(tokens: TokenAmt[]): {
  supplied: string
  borrowed: string
  title: string | undefined
} {
  const symbols = (side: TokenAmt['side']) =>
    tokens.filter((t) => t.side === side).map((t) => t.symbol)
  const detail = tokens
    .map((t) => `${t.side === 'borrow' ? '−' : '+'}${formatAmount(t.amount)} ${t.symbol}`)
    .join(' · ')
  return {
    supplied: symbols('supply').join(' / '),
    borrowed: symbols('borrow').join(' / '),
    title: detail || undefined,
  }
}

/**
 * A loan as a row of the positions table.
 *
 * The columns already ask the right questions, so it answers the ones that apply and says nothing
 * where they do not — an em dash, never a zero, because a loan has no PnL and no APR rather than
 * one of zero.
 *
 * **Range becomes health.** Both columns answer "how close to the edge is this": an LP marker
 * approaching the end of its band and a health factor approaching 1 are the same shape of warning,
 * so they share the position on the row where you look for it. The fill carries the health band's
 * own colour, which has three steps rather than the LP bar's two — "watch" is a real state between
 * healthy and at risk, and flattening it to green would lose the only warning you get in advance.
 *
 * **Value is net.** Collateral is already counted as spot aTokens on Holdings; showing it here
 * would double it. What this row adds to net worth is collateral minus debt, and the gross figures
 * sit under it in smaller type.
 */
function LendTableRow({ row }: { row: LendRow }) {
  const { money } = useMoney()
  const tone = hfTone(row.hf)
  const legs = lendLegs(row.tokens)
  const ltv = row.collateral_usd > 0 ? row.debt_usd / row.collateral_usd : 0
  const used = row.liq_threshold > 0 ? Math.min(1, ltv / row.liq_threshold) : 0
  const danger = row.hf !== null && row.hf < 1
  // `net_usd` is protocol-aware — see [[lendingPositions]]. On Aave the collateral is already in
  // the book as spot aTokens, so what the position *adds* is the debt alone and the cell shows a
  // negative number next to a five-figure collateral balance. That reads as a bug unless it says
  // why, so the arithmetic is spelled out rather than left to be inferred from the two figures.
  const netTitle =
    row.net_usd < 0 && row.collateral_usd > 0
      ? `The ${money(row.collateral_usd)} collateral is already counted as spot holdings, so what this position adds to net worth is the ${money(row.debt_usd)} debt`
      : `${money(row.collateral_usd)} collateral, less ${money(row.debt_usd)} debt`

  return (
    <TableRow className={cn(danger && 'bg-destructive/5')}>
      <TableCell className="whitespace-nowrap" title={legs.title}>
        <div className="flex items-center gap-2">
          <span
            role="img"
            aria-label="Lending — supplied as collateral against a borrow"
            title="Lending — supplied as collateral against a borrow"
            className="inline-flex shrink-0 text-muted-foreground"
          >
            <Landmark className="size-3.5" aria-hidden="true" />
          </span>
          <span className={cn('font-medium', legs.title && HAS_MORE)}>{legs.supplied || '—'}</span>
        </div>
        {legs.borrowed && (
          <div className="text-xs text-muted-foreground">borrowing {legs.borrowed}</div>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div>{chainLabel(row.chain)}</div>
        <div className="text-xs text-muted-foreground">{row.protocol}</div>
      </TableCell>
      <TableCell title={healthTitle(row, ltv)}>
        {row.debt_usd > 0 ? (
          <div className="flex items-center gap-2">
            <div className="relative h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('absolute inset-y-0 left-0 rounded-full', tone.bar)}
                style={{ width: `${Math.max(used * 100, 2)}%` }}
              />
            </div>
            <span className={cn('text-xs tabular-nums', HAS_MORE, tone.text)}>
              {row.hf === null ? '—' : row.hf.toFixed(2)}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">no debt</span>
        )}
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums" title={netTitle}>
        <span className={HAS_MORE}>{money(row.net_usd)}</span>
        {row.collateral_usd > 0 && (
          <div className="text-xs font-normal text-muted-foreground">
            {money(row.collateral_usd)} collateral
          </div>
        )}
      </TableCell>
      <TableCell className="text-right text-muted-foreground">—</TableCell>
      <TableCell className="text-right text-muted-foreground">—</TableCell>
      <TableCell className="text-right text-muted-foreground">—</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {row.hf === null ? 'health unknown' : tone.label}
      </TableCell>
    </TableRow>
  )
}

/**
 * What the health cell stops showing, on hover.
 *
 * The bar is "how much of the liquidation budget is spent" and the number is the health factor;
 * neither says what the budget was. Both loan-to-value figures go here, which is also the only
 * place the threshold this position is actually judged against is written down.
 */
function healthTitle(row: LendRow, ltv: number): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`
  const hf = row.hf === null ? 'unknown' : row.hf.toFixed(2)
  return `Health ${hf} — liquidated at 1.00 · LTV ${pct(ltv)} of ${pct(row.liq_threshold)} allowed`
}

/**
 * A loan as a card. **Below `sm` only**, for the same reason as [[PositionCard]].
 */
function LendCard({ row }: { row: LendRow }) {
  const { money } = useMoney()
  const tone = hfTone(row.hf)
  const legs = lendLegs(row.tokens)
  const danger = row.hf !== null && row.hf < 1

  return (
    <Card className={cn(danger && 'border-destructive/40')}>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Landmark className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <h3 className="font-medium">{legs.supplied || 'Lending'}</h3>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {row.protocol} · {chainLabel(row.chain)}
              {legs.borrowed && <> · borrowing {legs.borrowed}</>}
            </div>
          </div>
          <div className="text-right">
            <div className="font-semibold tabular-nums">{money(row.net_usd)}</div>
            {/* Not "net of debt": on Aave it is the debt, because the collateral beside it is
                already in the book as spot aTokens. */}
            <div className="text-xs text-muted-foreground">to net worth</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 border-t pt-3">
          <Metric label="Supplied" value={money(row.collateral_usd)} />
          <Metric label="Borrowed" value={money(row.debt_usd)} />
          {/* The label carries the state in words, so the colour is never the only thing saying
              this loan is in trouble. */}
          <Metric
            label={`Health · ${tone.label}`}
            value={
              <span className={tone.text}>{row.hf === null ? '—' : row.hf.toFixed(2)}</span>
            }
          />
        </div>
      </CardContent>
    </Card>
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
  const age = actionAge(row)
  const out = row.in_range === false

  return (
    <Card className={cn(out && 'border-destructive/40')}>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">{row.pair}</h3>
              <RangeBadge inRange={row.in_range} full={row.band?.full} />
              {row.poolType && <PoolTypeMark type={row.poolType} />}
            </div>
            <div
              className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
              title={venueTitle(row)}
            >
              <span>{row.protocol}</span>
              <span>·</span>
              <span>{chainLabel(row.chain)}</span>
              {age !== null && (
                <>
                  <span>·</span>
                  <span>{row.lastAction} {formatRelativeTime(age)}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-start gap-1">
            <SnowballToggle id={sbLpId(row.key)} name={row.pair} className="mt-0.5" />
            <div className="text-right">
              <div className="font-semibold tabular-nums">{money(row.value)}</div>
              <div className="text-xs text-muted-foreground">
                {rate(row.apr) ? <>{rate(row.apr)} APR</> : 'APR n/a'}
                {daily && <> · ≈{money(daily.perDay)}/day</>}
              </div>
              {/* "since opening" is rendered, not hovered. A `title` is invisible on a touch
                  screen, and this is the card layout — the one that only exists on a phone. Two
                  plausible readings of a PnL figure are both wrong (the 24h move, or the claimable
                  balance), so the label has to travel with the number. */}
              {row.pnlUsd !== null && (
                <div className="text-xs" title={pnlTitle(row)}>
                  <Pnl usd={row.pnlUsd} />
                  {row.pnlPct !== null && <> · <ChangeText value={row.pnlPct} /></>}
                  <div className="text-muted-foreground">since opening</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {range && (
          <div className="space-y-1">
            <RangeBar posPct={range.posPct} out={range.out} />
            <div className="flex flex-wrap justify-between gap-2 text-xs">
              <span className={cn(range.out ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')}>
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
 * Dialog content rather than a card: it is the detail behind the Claimable figure on the bar, and
 * a second card below the table was a second place to look for the same money.
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
function ClaimableBreakdown({ tokens, total }: { tokens: ClaimableToken[]; total: number }) {
  const { money } = useMoney()

  return (
    <div className="space-y-3">
      {/* The total repeats the figure that opened this, on purpose: the dialog covers the bar, and
          a list of parts with the whole missing makes you close it to check. */}
      <div className="flex items-baseline justify-between gap-2 border-b pb-2">
        <span className="text-xs tracking-wide text-muted-foreground uppercase">Total</span>
        <span className="text-xl font-semibold tabular-nums">{money(total)}</span>
      </div>
      <div>
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
      </div>
    </div>
  )
}

/**
 * The snowball, as one figure and a line.
 *
 * It was a card with a title, a subtitle, a two-segment bar and a paragraph — for a basket whose
 * only real question is "is it growing". A number and forty days of shape answer that in the space
 * the label alone used to take, and the full panel with the picker and the projection still lives
 * on Overview.
 *
 * Reads the whole book rather than the filtered rows: a basket total that shrinks when you filter
 * by chain is not a total.
 */
function SnowballFigure({
  ctx,
  rows,
  loading,
}: {
  ctx: Ctx | null
  rows: LpRow[]
  loading: boolean
}) {
  const { money } = useMoney()
  const { total, weekDelta } = useSnowball(ctx)
  const { isTagged } = useSnowballTags()

  const here = useMemo(
    () => rows.filter((r) => isTagged(sbLpId(r.key))).length,
    [rows, isTagged],
  )

  if (loading) return <Figure loading label="Snowball" value="" hint="" />

  const delta =
    weekDelta !== null && weekDelta !== 0
      ? `${weekDelta > 0 ? '+' : '−'}${money(Math.abs(weekDelta))} this week`
      : null

  const hint =
    total > 0
      ? `${here > 0 ? `${here} LP here` : 'none from this page'}${delta ? ` · ${delta}` : ''}`
      : 'press ❄ on a row to start one'

  // Nothing tagged yet means there is no history to plot, so the figure stays a figure rather
  // than offering a dialog that would open on an empty chart — and, with it, no expand glyph,
  // which is what keeps the glyph meaning "there is something behind this".
  if (total <= 0) return <Figure label="Snowball" value="—" hint={hint} />

  // The chart lives in the dialog rather than in the bar. A 56px line can say "rising" and
  // nothing else; the question you open a chart to ask — rising since when, and how steadily —
  // needs axes and a scale, which is exactly what the Overview panel already draws.
  return (
    <FigureDialog label="Snowball" value={money(total)} hint={hint}>
      {ctx && <SnowballPanel ctx={ctx} />}
    </FigureDialog>
  )
}
