/**
 * Opportunities — what is out there, rather than what beats what you hold.
 *
 * The deliberate complement to the yield radar. The radar is *relative*: it reads the wallet's own
 * farm balances, then only suggests pools that beat the APR it is already earning — which is the
 * right question for "should I move?" and useless for "what exists?". A wallet holding nothing
 * gets nothing from the radar, correctly. This page never consults a wallet at all.
 *
 * **Filtering happens on the server**, not here. vfat's feed is thousands of pools across 63
 * protocols; shipping them to the browser to filter would be slower and would lose the facets
 * their API already computes. Every control on this page is a query parameter.
 *
 * The TVL floor is the load-bearing default and the reason the floor is shown rather than hidden:
 * unfiltered, the top of an APR sort is a three-million-percent pool holding two hundred dollars.
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, Search, Telescope } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/core/components/empty-state'
import { USE_API } from '@/core/repositories'
import { apiWealthRepository } from '@/core/repositories/api-wealth-repository'
import { formatDuration, formatUsd } from './format'
import { formatApr, formatFee } from './opportunities-format'
import { chainLabel } from './identity'
import { ChainMark, TokenPairMark } from './marks'
import { useMoney } from './money'
import { RowsSkeleton, WealthError } from './states'
import type { ChainFreshness, YieldOpportunity } from './types'
import { StatCard } from './wealth-ui'

/** The sentinel Select value, matching the other wealth surfaces. */
const ALL = 'all'

/** How many pools to ask for. The server caps this at 50 whatever we send. */
const LIMIT = 20

/** Typing pause before a search reaches the API, so a word is one request rather than five. */
const SEARCH_DEBOUNCE_MS = 400

/**
 * Chains offered as a filter — the ones the backend maps to a name and this box actually reads.
 *
 * Not the full list vfat covers: "All chains" is the default and does return everything, including
 * chains no adapter here touches. This is a convenience for narrowing to where the user already
 * has money, not a claim about coverage.
 */
const FILTER_CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'hyperevm']

/** `sortKey` values the API accepts, with labels that say what they mean. */
const SORTS: { value: string; label: string }[] = [
  { value: 'apr', label: 'APR' },
  { value: 'tvl', label: 'TVL' },
  { value: 'inRangeTvl', label: 'In-range TVL' },
  { value: 'activeTvl', label: 'Active TVL' },
  { value: 'fees', label: 'Fees' },
  { value: 'rewards', label: 'Rewards' },
  { value: 'range', label: 'Range' },
]

const CORRELATIONS: { value: string; label: string }[] = [
  { value: 'correlated', label: 'Correlated' },
  { value: 'uncorrelated', label: 'Uncorrelated' },
  { value: 'unknown', label: 'Unknown' },
]

const MIN_APRS = ['10', '25', '50', '100']

/**
 * How fresh vfat's own view is.
 *
 * Its own endpoint rather than a guess: farm-balances answers 200 with data that can be hours old,
 * so "reachable" was never the question. `checked: false` is reported as unknown rather than
 * healthy — the one thing this strip must never do is vouch for data it did not see.
 */
function FreshnessStrip() {
  const status = useQuery({
    queryKey: ['wealth', 'vfat-status'],
    queryFn: () => apiWealthRepository.getVfatStatus(),
    staleTime: 60 * 1000,
    enabled: USE_API,
    retry: false,
  })

  if (!status.data) return null
  const { checked, behind, chains } = status.data

  if (!checked) {
    return (
      <p className="text-xs text-muted-foreground">
        vfat freshness unknown — the status endpoint could not be read.
      </p>
    )
  }

  const worst: ChainFreshness | undefined = chains.find((c) => c.behind)

  if (behind === 0 || !worst) {
    return (
      <p className="text-xs text-muted-foreground">
        vfat is current across {chains.length} {chains.length === 1 ? 'chain' : 'chains'}.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant="outline" className="gap-1 text-amber-600 dark:text-amber-500">
        <AlertTriangle className="size-3" aria-hidden="true" />
        {behind} {behind === 1 ? 'chain' : 'chains'} behind
      </Badge>
      <span className="text-muted-foreground">
        worst: {chainLabel(worst.chain)} {formatDuration(worst.time_lag_secs)} behind
        {worst.lagging_pipeline ? ` (${worst.lagging_pipeline})` : ''}
      </span>
    </div>
  )
}

function PoolRow({ row, compact }: { row: YieldOpportunity; compact: (usd: number) => string }) {
  return (
    <TableRow>
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          <TokenPairMark tokens={row.tokens.map((symbol) => ({ symbol }))} size="sm" />
          <span>{row.pair}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <ChainMark chain={row.chain} size="sm" />
          <span>{chainLabel(row.chain)}</span>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{row.protocol ?? '—'}</TableCell>
      <TableCell className="text-right tabular-nums">{formatApr(row.apr)}</TableCell>
      <TableCell className="text-right tabular-nums">{compact(row.tvl)}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{formatFee(row.fee)}</TableCell>
      <TableCell className="text-right">
        {row.url ? (
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            title={`Open ${row.pair} on ${row.protocol ?? 'the protocol'}`}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Open {row.pair}</span>
          </a>
        ) : null}
      </TableCell>
    </TableRow>
  )
}

function PoolCard({ row, compact }: { row: YieldOpportunity; compact: (usd: number) => string }) {
  return (
    <Card>
      <CardContent className="space-y-2 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <TokenPairMark tokens={row.tokens.map((symbol) => ({ symbol }))} size="sm" />
            <span>{row.pair}</span>
          </div>
          <span className="tabular-nums font-medium">{formatApr(row.apr)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ChainMark chain={row.chain} size="sm" />
            {chainLabel(row.chain)}
          </span>
          <span>{row.protocol ?? '—'}</span>
          <span className="tabular-nums">TVL {compact(row.tvl)}</span>
          <span className="tabular-nums">fee {formatFee(row.fee)}</span>
        </div>
      </CardContent>
    </Card>
  )
}

export function WealthOpportunitiesPage() {
  const { compact } = useMoney()

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [chain, setChain] = useState(ALL)
  const [sort, setSort] = useState('apr')
  const [correlation, setCorrelation] = useState(ALL)
  const [minApr, setMinApr] = useState(ALL)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const params = useMemo(() => {
    const next: Record<string, string> = { sort, limit: String(LIMIT) }
    if (chain !== ALL) next.chains = chain
    if (correlation !== ALL) next.correlation = correlation
    if (minApr !== ALL) next.min_apr = minApr
    if (debounced.trim()) next.search = debounced.trim()
    return next
  }, [sort, chain, correlation, minApr, debounced])

  const board = useQuery({
    queryKey: ['wealth', 'opportunities', params],
    queryFn: () => apiWealthRepository.getOpportunities(params),
    // Discovery data, not the user's book: the server already caches it for five minutes, and
    // re-asking on every focus change would spend a request to redraw the same rows.
    staleTime: 5 * 60 * 1000,
    enabled: USE_API,
    retry: false,
  })

  const hasFilters = chain !== ALL || correlation !== ALL || minApr !== ALL || search.trim() !== ''
  const clearFilters = () => {
    setChain(ALL)
    setCorrelation(ALL)
    setMinApr(ALL)
    setSearch('')
  }

  // A demo session has no mock for this: the rows are live pools on live chains, and inventing
  // them would be indistinguishable from the real thing on a page whose whole job is to be
  // trusted enough to act on.
  if (!USE_API) {
    return (
      <EmptyState
        icon={Telescope}
        title="Opportunities needs the live backend"
        description="These are real pools read from vfat. Switch this session to live data to see them."
      />
    )
  }

  if (board.isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <RowsSkeleton rows={6} />
        </CardContent>
      </Card>
    )
  }

  if (board.error) {
    return (
      <WealthError
        detail={board.error.message}
        onRetry={() => board.refetch()}
        retrying={board.isFetching}
      />
    )
  }

  const rows = board.data?.opportunities ?? []
  const floor = board.data?.filters.min_tvl ?? null

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Pools found" value={String(rows.length)} hint={`top ${LIMIT} by ${SORTS.find((s) => s.value === sort)?.label ?? sort}`} />
        <StatCard
          label="Best APR"
          value={rows.length ? formatApr(Math.max(...rows.map((r) => r.apr))) : '—'}
          hint="advertised, not realized"
        />
        <StatCard
          label="TVL floor"
          value={floor === null ? '—' : formatUsd(floor, { compact: true })}
          hint="pools below this are hidden"
        />
      </div>

      <FreshnessStrip />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search
            className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search pair or token"
            className="w-[200px] pl-8"
            aria-label="Search pair or token"
          />
        </div>

        <Select value={chain} onValueChange={setChain}>
          <SelectTrigger className="w-[150px]" aria-label="Chain">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All chains</SelectItem>
            {FILTER_CHAINS.map((c) => (
              <SelectItem key={c} value={c}>
                <span className="flex items-center gap-2">
                  <ChainMark chain={c} size="sm" />
                  {chainLabel(c)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger className="w-[150px]" aria-label="Sort by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                Sort: {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={correlation} onValueChange={setCorrelation}>
          <SelectTrigger className="w-[160px]" aria-label="Asset correlation">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any correlation</SelectItem>
            {CORRELATIONS.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={minApr} onValueChange={setMinApr}>
          <SelectTrigger className="w-[140px]" aria-label="Minimum APR">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any APR</SelectItem>
            {MIN_APRS.map((a) => (
              <SelectItem key={a} value={a}>
                APR ≥ {a}%
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear
          </Button>
        )}

        {board.isFetching && <span className="text-xs text-muted-foreground">Updating…</span>}
      </div>

      {rows.length === 0 ? (
        // Distinct from the empty state on purpose: the feed answered, and the answer was that
        // nothing clears these filters. Saying "no opportunities" would blame the market for a
        // filter the user set.
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No pools match these filters{floor === null ? '' : ` above ${formatUsd(floor, { compact: true })} TVL`}.
            </p>
            {hasFilters && (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border sm:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Pair</TableHead>
                  <TableHead>Chain</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead className="text-right">APR</TableHead>
                  <TableHead className="text-right">TVL</TableHead>
                  <TableHead className="text-right">Fee</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <PoolRow
                    key={`${row.chain_id}:${row.pair}:${row.protocol}`}
                    row={row}
                    compact={compact}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2 sm:hidden">
            {rows.map((row) => (
              <PoolCard
                key={`${row.chain_id}:${row.pair}:${row.protocol}`}
                row={row}
                compact={compact}
              />
            ))}
          </div>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        APR is what the protocol advertises, not what a position realized. Nothing here reads your
        wallet — see DeFi for what you actually hold.
      </p>
    </div>
  )
}
