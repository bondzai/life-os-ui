/**
 * Wealth · Holdings — every position as one filterable ledger.
 *
 * Same-symbol balances stay separate per chain rather than being merged. That looks redundant
 * until you need to know *where* the USDC is in order to bridge or spend it, which is the actual
 * question this page exists to answer.
 */

import { useMemo, useState } from 'react'
import { Search, Wallet, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/core/components/empty-state'
import {
  EMPTY_FILTERS,
  TIER_LABELS,
  chainsInData,
  flatList,
  groupRows,
  sumUsd,
  walletsInData,
  type Filters,
  type FlatRow,
  type GroupBy,
} from './derive'
import { useMoney } from './money'
import { chainLabel, formatAmount, formatRelativeTime } from './format'
import { RowsSkeleton, StaleBanner, WealthError } from './states'
import type { Tier } from './types'
import { useWealth } from './use-wealth'
import { ChangeText, MetaPill, StatCard } from './wealth-ui'

const ALL = 'all'

export function WealthHoldingsPage() {
  const { compact } = useMoney()
  const { ctx, isLoading, error, isEmpty, isRefreshing, isStale, refetch } = useWealth()

  const [query, setQuery] = useState('')
  const [chain, setChain] = useState<string>(ALL)
  const [tier, setTier] = useState<string>(ALL)
  const [type, setType] = useState<Filters['type']>('all')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')

  const chains = useMemo(() => (ctx ? chainsInData(ctx.data) : []), [ctx])
  const wallets = useMemo(() => (ctx ? walletsInData(ctx.data) : []), [ctx])

  const rows = useMemo(() => {
    if (!ctx) return []
    const filters: Filters = {
      ...EMPTY_FILTERS,
      chains: chain === ALL ? new Set() : new Set([chain]),
      tier: tier === ALL ? null : (tier as Tier),
      type,
      query,
    }
    return flatList(ctx, filters)
  }, [ctx, chain, tier, type, query])

  const groups = useMemo(() => groupRows(rows, groupBy), [rows, groupBy])
  const total = useMemo(() => sumUsd(rows), [rows])
  const largest = rows[0] ?? null
  const hasFilters = query !== '' || chain !== ALL || tier !== ALL || type !== 'all'

  const clearFilters = () => {
    setQuery('')
    setChain(ALL)
    setTier(ALL)
    setType('all')
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <RowsSkeleton rows={8} />
        </CardContent>
      </Card>
    )
  }

  if (error) return <WealthError detail={error.message} onRetry={refetch} retrying={isRefreshing} />

  if (isEmpty || !ctx) {
    return (
      <EmptyState
        icon={Wallet}
        title="No holdings yet"
        description="Connect a wallet to see your balances and positions here."
      />
    )
  }

  return (
    <div className="space-y-4">
      {isStale && (
        <StaleBanner age={formatRelativeTime(ctx.data.fetched_at)} onRefresh={refetch} refreshing={isRefreshing} />
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label={hasFilters ? 'Filtered value' : 'Total book'}
          value={compact(total)}
          hint={`${rows.length} position${rows.length === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Largest position"
          value={largest ? compact(largest.usd) : '—'}
          hint={largest ? `${largest.label} · ${chainLabel(largest.chain)}` : undefined}
        />
        <StatCard
          label="Accounts"
          value={wallets.length}
          hint={`across ${chains.length} chain${chains.length === 1 ? '' : 's'}`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search asset, protocol or chain…"
            className="pl-8"
          />
        </div>

        <Select value={chain} onValueChange={setChain}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Chain" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All chains</SelectItem>
            {chains.map((c) => (
              <SelectItem key={c} value={c}>{chainLabel(c)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={tier} onValueChange={setTier}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All tiers</SelectItem>
            {(Object.keys(TIER_LABELS) as Tier[]).map((t) => (
              <SelectItem key={t} value={t}>{TIER_LABELS[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={type} onValueChange={(v) => setType(v as Filters['type'])}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="wallet">Wallet only</SelectItem>
            <SelectItem value="defi">DeFi only</SelectItem>
          </SelectContent>
        </Select>

        <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Group" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No grouping</SelectItem>
            <SelectItem value="chain">By chain</SelectItem>
            <SelectItem value="tier">By tier</SelectItem>
            <SelectItem value="account">By account</SelectItem>
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 size-3.5" /> Clear
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        // Distinct from the no-wallets empty state above: here the data loaded fine and the
        // filters simply excluded everything, so the fix is to relax them.
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">No holdings match these filters</p>
            <p className="mt-1 text-sm text-muted-foreground">Try widening the search or clearing a filter.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>
              Clear filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="text-right">24h</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <GroupSection
                  key={group.key}
                  name={groupBy === 'none' ? null : group.key}
                  usd={group.usd}
                  change={group.change}
                  rows={group.rows}
                />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}

function GroupSection({
  name,
  usd,
  change,
  rows,
}: {
  name: string | null
  usd: number
  change: number | null
  rows: FlatRow[]
}) {
  const { money, compact } = useMoney()
  return (
    <>
      {name && (
        <TableRow className="bg-muted/50 hover:bg-muted/50">
          <TableCell colSpan={3} className="font-medium">
            {chainLabel(name)}
            <span className="ml-2 text-xs text-muted-foreground">
              {rows.length} position{rows.length === 1 ? '' : 's'}
            </span>
          </TableCell>
          <TableCell className="text-right font-semibold tabular-nums">{compact(usd)}</TableCell>
          <TableCell className="text-right text-sm">
            <ChangeText value={change} />
          </TableCell>
        </TableRow>
      )}
      {rows.map((row) => (
        <TableRow key={row.key}>
          <TableCell>
            <div className="font-medium">{row.label}</div>
            {row.sub && <div className="text-xs text-muted-foreground">{row.sub}</div>}
          </TableCell>
          <TableCell>
            <div className="flex flex-wrap items-center gap-1">
              <MetaPill>{chainLabel(row.chain)}</MetaPill>
              <MetaPill>{row.account}</MetaPill>
              {row.kind === 'defi' && <MetaPill>DeFi</MetaPill>}
            </div>
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {row.amount !== undefined ? (
              <>
                {formatAmount(row.amount)}
                {row.symbol && <span className="ml-1 text-xs text-muted-foreground">{row.symbol}</span>}
              </>
            ) : row.tokens && row.tokens.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                {row.tokens.map((t) => t.symbol).join(' / ')}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </TableCell>
          <TableCell className="text-right font-medium tabular-nums">{money(row.usd)}</TableCell>
          <TableCell className="text-right text-sm">
            <ChangeText value={row.change} />
          </TableCell>
        </TableRow>
      ))}
    </>
  )
}
