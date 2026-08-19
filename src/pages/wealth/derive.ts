/**
 * Portfolio derivations — the port of the old app's `lib/compute.ts`.
 *
 * All the arithmetic that turns the wire format into what the surfaces render lives here, away
 * from the components, because these formulas are the part that must stay correct: a component
 * rendering the wrong number still looks fine. Ported behaviour-for-behaviour, including the
 * non-obvious rules (lending is netted rather than summed, DeFi is exempt from the dust filter),
 * each of which is called out below — they encode real accounting decisions, not preferences.
 */

import type {
  ChainBucket,
  DefiPosition,
  Holding,
  LendRow,
  LpRow,
  ManualAsset,
  NwPoint,
  PortfolioData,
  PriceBand,
  Tier,
  TokenAmt,
  Wallet,
} from './types'

/** Everything the derivations need. `dustUsd` of 0 shows every balance. */
export interface Ctx {
  data: PortfolioData
  manual: ManualAsset[]
  dustUsd: number
}

/**
 * Symbols treated as long-term store-of-value regardless of where they sit.
 * Hardcoded in the original: it is a statement of intent about what "store" means, so it is a
 * list to edit deliberately, not something to infer from price behaviour.
 */
const STORE_SYMBOLS = new Set([
  'BTC', 'WBTC', 'CBBTC', 'TBTC', 'LBTC',
  'ETH', 'WETH', 'STETH', 'WSTETH', 'RETH', 'WEETH',
  'XAUT', 'PAXG', 'KAU', 'XAU', 'GOLD',
])

const TRADING_CATEGORIES = new Set(['Perps', 'Futures', 'Rebalance', 'Spot Grid'])
const BUSINESS_CATEGORIES = new Set(['Liquidity Pool', 'Yield'])

export const TIER_LABELS: Record<Tier, string> = {
  store: 'Store',
  business: 'Business',
  trading: 'Trading',
}

/** Which tier a holding belongs to. Category wins over symbol: a BTC perp is a trade, not a store. */
export function classify(item: { symbol?: string; category?: string }): Tier {
  const category = item.category ?? ''
  if (TRADING_CATEGORIES.has(category)) return 'trading'
  if (BUSINESS_CATEGORIES.has(category)) return 'business'
  if (STORE_SYMBOLS.has((item.symbol ?? '').toUpperCase())) return 'store'
  // Cash, stables and alts all default to business — capital that is meant to be working.
  return 'business'
}

function defiLabel(position: DefiPosition): string {
  const { protocol, name } = position
  if (name && protocol && name !== protocol) return `${protocol} · ${name}`
  return name || protocol
}

/** USD value of an off-chain asset, converting from its own denomination. */
export function manualUsd(asset: ManualAsset, ctx: Ctx): number {
  const rates = ctx.data.rates
  const value = asset.value ?? 0
  if (asset.ccy === 'thb') {
    const thb = rates?.thb
    return typeof thb === 'number' && thb > 0 ? value / thb : 0
  }
  if (asset.ccy === 'sats') {
    const btcUsd = rates?.btc_usd
    return typeof btcUsd === 'number' ? (value / 100_000_000) * btcUsd : 0
  }
  return value
}

function eachChain(data: PortfolioData, fn: (wallet: Wallet, chain: ChainBucket) => void): void {
  for (const wallet of data.wallets) {
    for (const chain of wallet.chains) fn(wallet, chain)
  }
}

/**
 * The flat holdings list behind net worth and the tier split.
 *
 * Lending positions (those carrying `health`) are deliberately excluded and netted separately by
 * `lendingNet` — Aave's collateral already shows up as spot aTokens, so counting the position
 * here too would book the same money twice.
 */
export function holdings(ctx: Ctx): Holding[] {
  const rows: Holding[] = []

  eachChain(ctx.data, (_wallet, chain) => {
    for (const token of chain.spot) {
      rows.push({
        label: token.symbol,
        usd: token.usd,
        tier: classify(token),
        chain: chain.chain,
        change: token.change24h ?? null,
        kind: 'spot',
      })
    }
    for (const position of chain.defi) {
      if (position.health) continue // netted by lendingNet, not summed here
      rows.push({
        label: defiLabel(position),
        usd: position.usd ?? 0,
        tier: classify({ symbol: position.tokens[0]?.symbol, category: position.category }),
        chain: chain.chain,
        change: position.change24h ?? null,
        kind: 'defi',
      })
    }
  })

  for (const asset of ctx.manual) {
    rows.push({
      label: asset.name,
      usd: manualUsd(asset, ctx),
      tier: asset.tier, // stored on the asset; never reclassified
      chain: asset.chain || 'off-chain',
      change: null,
      kind: 'manual',
      manual: true,
    })
  }

  const dust = ctx.dustUsd || 0
  // DeFi is exempt from the dust floor on purpose: a small LP is a real position the user opened,
  // whereas a small spot balance is usually a stray airdrop.
  return rows.filter((h) => h.usd > 0 && (h.kind === 'defi' || h.usd >= dust))
}

export function sumUsd(rows: { usd: number }[]): number {
  return rows.reduce((total, r) => total + r.usd, 0)
}

/**
 * Borrow positions flattened for the health UI.
 *
 * `net_usd` is protocol-aware because the two families account differently: Aave's collateral is
 * already visible as spot aTokens (so only the debt is new information), while Compound/Morpho
 * hold collateral in-contract (so the whole position nets).
 */
export function lendingPositions(data: PortfolioData): LendRow[] {
  const rows: LendRow[] = []
  eachChain(data, (_wallet, chain) => {
    for (const position of chain.defi) {
      const health = position.health
      if (!health) continue
      const protocol = position.protocol
      const isAave = protocol.toLowerCase().includes('aave')
      rows.push({
        key: `${protocol}:${chain.chain}:${position.id ?? position.name}`,
        protocol,
        chain: chain.chain,
        hf: health.hf,
        ltv: health.ltv,
        liq_threshold: health.liq_threshold,
        collateral_usd: health.collateral_usd,
        debt_usd: health.debt_usd,
        net_usd: isAave ? -health.debt_usd : health.collateral_usd - health.debt_usd,
        tokens: position.tokens,
      })
    }
  })
  return rows
}

export function lendingNet(data: PortfolioData): number {
  return lendingPositions(data).reduce((total, r) => total + r.net_usd, 0)
}

/** Net worth = gross holdings + the (negative) lending contribution. */
export function netWorth(ctx: Ctx, rows: Holding[] = holdings(ctx)): number {
  return sumUsd(rows) + lendingNet(ctx.data)
}

export function tierTotals(rows: Holding[]): Record<Tier, number> {
  const totals: Record<Tier, number> = { store: 0, business: 0, trading: 0 }
  for (const row of rows) totals[row.tier] += row.usd
  return totals
}

/**
 * Blended 24h change: each holding's own 24h percentage, weighted by its size.
 *
 * A plain average would let a $10 airdrop that doubled outweigh the entire portfolio.
 * Holdings with no change data are left out of both sides of the ratio rather than treated as 0%,
 * which would drag the blend toward zero.
 */
export function portfolioChange(rows: Holding[]): number | null {
  let weight = 0
  let weighted = 0
  for (const row of rows) {
    if (row.change === null || !Number.isFinite(row.change)) continue
    weight += row.usd
    weighted += row.usd * row.change
  }
  return weight > 0 ? weighted / weight : null
}

/** USD-weighted average 24h change for an arbitrary row set (group headers). */
export function weightedChange(rows: { usd: number; change: number | null }[]): number | null {
  let weight = 0
  let weighted = 0
  for (const row of rows) {
    if (row.change === null || !Number.isFinite(row.change)) continue
    weight += row.usd
    weighted += row.usd * row.change
  }
  return weight > 0 ? weighted / weight : null
}

// ---------------------------------------------------------------------------
// Holdings ledger
// ---------------------------------------------------------------------------

/** One rendered ledger row. Richer than `Holding`: it keeps the identifying detail a table needs. */
export interface FlatRow {
  key: string
  label: string
  sub?: string
  symbol?: string
  amount?: number
  usd: number
  tier: Tier
  chain: string
  account: string
  change: number | null
  kind: 'spot' | 'defi' | 'manual'
  tokens?: TokenAmt[]
}

export interface Filters {
  /** empty set = no wallet restriction */
  wallets: Set<string>
  chains: Set<string>
  tier: Tier | null
  type: 'all' | 'wallet' | 'defi'
  query: string
  minUsd: number
}

export const EMPTY_FILTERS: Filters = {
  wallets: new Set(),
  chains: new Set(),
  tier: null,
  type: 'all',
  query: '',
  minUsd: 0,
}

function accountLabel(address: string): string {
  if (address === 'kucoin') return 'KuCoin'
  if (address.length <= 14) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * The ledger the Holdings surface renders.
 *
 * Note this is NOT `holdings()` with filters bolted on: same-symbol balances stay separate per
 * chain, because "3 USDC rows" is the honest answer when the money is on three chains and the
 * user is deciding where to bridge from.
 */
export function flatList(ctx: Ctx, filters: Filters): FlatRow[] {
  // The page's own minimum and the global dust floor compose — the stricter one wins.
  const floor = Math.max(filters.minUsd, ctx.dustUsd || 0)
  const query = filters.query.trim().toLowerCase()
  const rows: FlatRow[] = []

  const matches = (usd: number, parts: (string | undefined)[]): boolean => {
    if (usd < floor) return false
    if (!query) return true
    return parts.filter(Boolean).join(' ').toLowerCase().includes(query)
  }

  for (const wallet of ctx.data.wallets) {
    if (filters.wallets.size > 0 && !filters.wallets.has(wallet.address)) continue
    const account = accountLabel(wallet.address)

    for (const chain of wallet.chains) {
      if (filters.chains.size > 0 && !filters.chains.has(chain.chain)) continue

      if (filters.type !== 'defi') {
        for (const token of chain.spot) {
          if (!matches(token.usd, [token.symbol, token.coin, chain.chain])) continue
          rows.push({
            key: `${wallet.address}:${chain.chain}:spot:${token.symbol}`,
            label: token.symbol,
            symbol: token.symbol,
            amount: token.amount,
            usd: token.usd,
            tier: classify(token),
            chain: chain.chain,
            account,
            change: token.change24h ?? null,
            kind: 'spot',
          })
        }
      }

      if (filters.type !== 'wallet') {
        for (const position of chain.defi) {
          if (position.health) continue // shown by the lending view, never as a holding
          const usd = position.usd ?? 0
          if (!matches(usd, [position.protocol, position.name, chain.chain])) continue
          rows.push({
            key: `${wallet.address}:${chain.chain}:defi:${position.id ?? position.name}`,
            label: position.protocol,
            sub: position.name,
            usd,
            tier: classify({ symbol: position.tokens[0]?.symbol, category: position.category }),
            chain: chain.chain,
            account,
            change: position.change24h ?? null,
            kind: 'defi',
            tokens: position.tokens,
          })
        }
      }
    }
  }

  if (filters.type !== 'defi') {
    for (const asset of ctx.manual) {
      const usd = manualUsd(asset, ctx)
      const chain = asset.chain || 'off-chain'
      if (filters.chains.size > 0 && !filters.chains.has(chain)) continue
      if (!matches(usd, [asset.name, asset.note, chain])) continue
      rows.push({
        key: `manual:${asset.name}`,
        label: asset.name,
        sub: asset.note,
        usd,
        tier: asset.tier,
        chain,
        account: 'Off-chain',
        change: null,
        kind: 'manual',
      })
    }
  }

  return rows
    .filter((r) => (!filters.tier || r.tier === filters.tier) && r.usd > 0)
    .sort((a, b) => b.usd - a.usd)
}

export type GroupBy = 'none' | 'chain' | 'tier' | 'account'

export interface RowGroup {
  key: string
  rows: FlatRow[]
  usd: number
  change: number | null
}

/** Buckets ledger rows, groups ordered by size so the biggest exposure reads first. */
export function groupRows(rows: FlatRow[], groupBy: GroupBy): RowGroup[] {
  if (groupBy === 'none') return [{ key: 'all', rows, usd: sumUsd(rows), change: weightedChange(rows) }]
  const buckets = new Map<string, FlatRow[]>()
  for (const row of rows) {
    const key = groupBy === 'chain' ? row.chain : groupBy === 'tier' ? TIER_LABELS[row.tier] : row.account
    const existing = buckets.get(key)
    if (existing) existing.push(row)
    else buckets.set(key, [row])
  }
  return [...buckets.entries()]
    .map(([key, groupRowsList]) => ({
      key,
      rows: groupRowsList,
      usd: sumUsd(groupRowsList),
      change: weightedChange(groupRowsList),
    }))
    .sort((a, b) => b.usd - a.usd)
}

/** Distinct chains present in the data, for the filter control. */
export function chainsInData(data: PortfolioData): string[] {
  const seen = new Set<string>()
  eachChain(data, (_wallet, chain) => seen.add(chain.chain))
  return [...seen].sort()
}

export function walletsInData(data: PortfolioData): { address: string; label: string; total: number }[] {
  return data.wallets.map((w) => ({ address: w.address, label: accountLabel(w.address), total: w.total }))
}

// ---------------------------------------------------------------------------
// DeFi / LP positions
// ---------------------------------------------------------------------------

/** The display pair for an LP: its own name, else the token symbols joined. */
function lpPair(position: DefiPosition): string {
  return position.name || position.tokens.map((t) => t.symbol).join('/')
}

/**
 * Stable row identities.
 *
 * Exported because the snowball tags positions by these strings and stores them in localStorage:
 * a key that changed shape between renders would silently drop someone's tags, so both the rows
 * and the tags must be built from the same function rather than from two copies of the formula.
 */
export function lpKey(position: DefiPosition, chain: string): string {
  return `${position.protocol}:${chain}:${position.id || lpPair(position)}`
}

export function botKey(address: string, chain: string, position: DefiPosition): string {
  return `${address}:${chain}:${position.id ?? position.name}`
}

/**
 * LP and farm positions.
 *
 * Presence of a `rewards` key is what identifies them — lending carries `health` instead and bots
 * carry `bot`, so this is the original's discriminator and is kept rather than guessed at from
 * `category`, which is free text.
 */
export function lpPositions(data: PortfolioData): LpRow[] {
  const rows: LpRow[] = []
  eachChain(data, (_wallet, chain) => {
    for (const position of chain.defi) {
      if (!('rewards' in position)) continue
      const pair = lpPair(position)
      rows.push({
        key: lpKey(position, chain.chain),
        protocol: position.protocol,
        pair,
        chain: chain.chain,
        value: position.usd ?? 0,
        fees: position.rewards_usd ?? 0,
        // Falls back to the full rewards figure when a protocol does not break swap fees out.
        swapFees: position.swap_fees_usd ?? position.rewards_usd ?? 0,
        in_range: position.in_range ?? null,
        id: position.id,
        via: position.via,
        cl: position.tick_spacing ?? null,
        band: position.price_band ?? null,
        toks: position.tokens.filter((t) => t.amount > 0),
        feeToks: (position.rewards ?? []).filter((t) => t.amount > 0),
        apr: position.apr ?? null,
        rangePct: position.range_pct ?? null,
        deployedAt: position.deployed_at ?? null,
        updatedAt: position.updated_at ?? null,
        lastAction: position.last_action ?? null,
        poolType: position.pool_type ?? null,
        inRangeSecs: position.in_range_secs ?? null,
        cycleStart: position.cycle_start ?? null,
        // Only the truthiness of the harvest timestamp survives: it anchors the fee cycle.
        harvested: Boolean(position.last_harvest_at),
      })
    }
  })
  return rows
}

/**
 * Total claimable across positions, de-duplicated by claim id.
 *
 * A wallet-level campaign claim is attached to every position that earned it, so summing
 * naively would multiply one reward by the number of positions showing it.
 */
export function claimableUsd(rows: LpRow[]): number {
  const seen = new Set<string>()
  let total = 0
  for (const row of rows) {
    for (const token of row.feeToks) {
      if (token.claim) {
        if (seen.has(token.claim)) continue
        seen.add(token.claim)
      }
      total += token.usd ?? 0
    }
  }
  return total
}

export interface ClaimableToken {
  symbol: string
  amount: number
  usd: number
}

/** Claimable rewards aggregated per token, same claim-id dedup as `claimableUsd`. */
export function claimableByToken(rows: LpRow[]): ClaimableToken[] {
  const seen = new Set<string>()
  const totals = new Map<string, ClaimableToken>()
  for (const row of rows) {
    for (const token of row.feeToks) {
      if (token.claim) {
        if (seen.has(token.claim)) continue
        seen.add(token.claim)
      }
      const existing = totals.get(token.symbol)
      if (existing) {
        existing.amount += token.amount
        existing.usd += token.usd ?? 0
      } else {
        totals.set(token.symbol, { symbol: token.symbol, amount: token.amount, usd: token.usd ?? 0 })
      }
    }
  }
  return [...totals.values()].sort((a, b) => b.usd - a.usd)
}

/** Out-of-range first — those are the positions that have stopped earning and need action. */
export function statusRank(row: LpRow): number {
  if (row.in_range === false) return 0
  if (row.in_range === true) return 1
  return 2
}

export type LpSortKey = 'health' | 'pair' | 'chain' | 'protocol' | 'value' | 'fees' | 'apr' | 'updated'

export function sortLp(rows: LpRow[], key: LpSortKey, dir: 'asc' | 'desc'): LpRow[] {
  const sorted = [...rows]
  if (key === 'health') {
    // Deliberately ignores `dir`: "needs attention first" has only one useful direction.
    return sorted.sort((a, b) => statusRank(a) - statusRank(b) || b.fees - a.fees)
  }
  const sign = dir === 'asc' ? 1 : -1
  const value = (row: LpRow): number | string => {
    switch (key) {
      case 'pair': return row.pair.toLowerCase()
      case 'chain': return row.chain.toLowerCase()
      case 'protocol': return row.protocol.toLowerCase()
      case 'value': return row.value
      case 'fees': return row.fees
      case 'apr': return row.apr ?? -1
      case 'updated': return row.updatedAt ? Date.parse(row.updatedAt) : -1
    }
  }
  return sorted.sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    if (typeof av === 'string' && typeof bv === 'string') return sign * av.localeCompare(bv)
    return sign * (Number(av) - Number(bv))
  })
}

/** Capital-weighted APR across positions that report one. */
export function blendedApr(rows: LpRow[]): number | null {
  let weight = 0
  let weighted = 0
  for (const row of rows) {
    if (row.apr === null || !Number.isFinite(row.apr)) continue
    weight += row.value
    weighted += row.apr * row.value
  }
  return weight > 0 ? weighted / weight : null
}

export interface RangeInfo {
  /** where spot sits inside the band, 0–100% */
  posPct: number
  /** headroom down to the lower bound, as % of spot */
  toLow: number
  /** headroom up to the upper bound, as % of spot */
  toHigh: number
  /** band width as % of spot */
  width: number
  out: boolean
  edge: string
}

/**
 * Band geometry for display.
 *
 * `out` is read from `in_range`, never recomputed from the bounds: the server knows the real tick
 * and the band here is a rounded human-readable projection, so re-deriving it would occasionally
 * contradict the badge next to it.
 */
export function rangeInfo(row: LpRow): RangeInfo | null {
  const band: PriceBand | null = row.band
  if (!band || band.full) return null
  const { lower, upper, cur } = band
  if (lower === null || upper === null || cur === null || upper <= lower || cur <= 0) return null

  const posPct = Math.min(100, Math.max(0, ((cur - lower) / (upper - lower)) * 100))
  const toLow = ((cur - lower) / cur) * 100
  const toHigh = ((upper - cur) / cur) * 100
  const width = ((upper - lower) / cur) * 100
  const out = row.in_range === false

  let edge: string
  if (out) {
    edge = cur < lower
      ? `${Math.abs(((cur - lower) / lower) * 100).toFixed(1)}% below min`
      : `${Math.abs(((cur - upper) / upper) * 100).toFixed(1)}% above max`
  } else {
    edge = `↓ ${toLow.toFixed(1)}% to min · ↑ ${toHigh.toFixed(1)}% to max`
  }
  return { posPct, toLow, toHigh, width, out, edge }
}

export interface CyclePerf {
  elapsedSecs: number
  anchor: 'harvest' | 'deploy'
  inRangeSecs: number | null
  /** share of the cycle spent earning, 0–100 */
  pct: number | null
}

/**
 * Real in-range time this fee cycle.
 *
 * The server samples in/out state around the clock and accumulates `in_range_secs` since
 * `cycle_start`, so fees ÷ in-range time is a truer yield than fees ÷ wall-clock: an
 * out-of-range position earns nothing while the clock keeps running.
 */
export function cyclePerf(row: LpRow, now: number = Date.now()): CyclePerf | null {
  if (row.cycleStart === null) return null
  const elapsedSecs = Math.max(0, now / 1000 - row.cycleStart)
  const pct = row.inRangeSecs !== null && elapsedSecs > 0
    ? Math.min(100, (row.inRangeSecs / elapsedSecs) * 100)
    : null
  return {
    elapsedSecs,
    anchor: row.harvested ? 'harvest' : 'deploy',
    inRangeSecs: row.inRangeSecs,
    pct,
  }
}

/** Projected earnings at the position's advertised APR. */
export function earnings(row: LpRow, now: number = Date.now()): { perDay: number; perYear: number } | null {
  if (row.apr === null || !row.value) return null
  const perYear = (row.apr / 100) * row.value
  void now
  return { perDay: perYear / 365, perYear }
}

// ---------------------------------------------------------------------------
// Net-worth history
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

export interface WindowPerf {
  points: NwPoint[]
  delta: number
  pct: number | null
  spanDays: number
  low: number
  high: number
}

/**
 * Performance over a trailing window of the daily snapshot series.
 *
 * Falls back to the last two points when the window is too sparse, so a new user with three
 * days of history still sees a real delta instead of an empty chart.
 */
export function windowPerf(series: NwPoint[], days: number, now: number = Date.now()): WindowPerf | null {
  if (series.length === 0) return null
  const sorted = [...series].sort((a, b) => a.d - b.d)
  const today = Math.floor(now / DAY_MS) * DAY_MS
  let points = Number.isFinite(days) ? sorted.filter((p) => p.d >= today - days * DAY_MS) : sorted
  if (points.length < 2) points = sorted.slice(-2)
  if (points.length < 2) return null

  const start = points[0]
  const cur = points[points.length - 1]
  const delta = cur.v - start.v
  const values = points.map((p) => p.v)
  return {
    points,
    delta,
    pct: start.v ? (delta / start.v) * 100 : null,
    spanDays: Math.round((cur.d - start.d) / DAY_MS),
    low: Math.min(...values),
    high: Math.max(...values),
  }
}

// ---------------------------------------------------------------------------------------------
// BTC reserves — true bitcoin exposure, wrappers unwrapped
// ---------------------------------------------------------------------------------------------

/**
 * Symbols that ARE bitcoin, however they are wrapped.
 *
 * Deliberately narrower than `STORE_SYMBOLS`: this answers "how much bitcoin do I actually have",
 * so ETH and gold are not in it. A wrapper counts because redeeming it gives you BTC — the whole
 * point of the panel is that the answer does not change when you move between wrappers.
 */
const BTC_SYMBOLS = new Set(['BTC', 'WBTC', 'CBBTC', 'TBTC', 'LBTC', 'UBTC', 'SOLVBTC', 'XSOLVBTC', 'BTCB'])

export function isBtcSymbol(symbol: string | undefined): boolean {
  return BTC_SYMBOLS.has((symbol ?? '').toUpperCase())
}

/** One wrapper, and how much of the reserve it accounts for. */
export interface BtcComponent {
  symbol: string
  usd: number
}

/** Where the bitcoin is held, and under whose custody. */
export interface BtcLocation {
  label: string
  kind: 'cold' | 'cex' | 'custodial' | 'onchain'
  usd: number
}

export interface BtcReserves {
  usd: number
  /** Sats, or `null` when no BTC price is available — never 0, which would read as "none held". */
  sats: number | null
  components: BtcComponent[]
  locations: BtcLocation[]
}

/**
 * Total bitcoin exposure across spot, LP legs, bot baskets and off-chain assets.
 *
 * Lending positions are skipped: their collateral is already counted as spot aTokens, so adding
 * the position too would double the reserve.
 */
export function btcReserves(ctx: Ctx): BtcReserves {
  const bySymbol = new Map<string, number>()
  const byLocation = new Map<string, BtcLocation>()

  const add = (symbol: string | undefined, usd: number): number => {
    if (!isBtcSymbol(symbol) || !(usd > 0)) return 0
    const key = (symbol as string).toUpperCase()
    bySymbol.set(key, (bySymbol.get(key) ?? 0) + usd)
    return usd
  }
  const addLocation = (label: string, kind: BtcLocation['kind'], usd: number) => {
    if (!(usd > 0)) return
    const existing = byLocation.get(label) ?? { label, kind, usd: 0 }
    existing.usd += usd
    byLocation.set(label, existing)
  }

  for (const wallet of ctx.data.wallets) {
    // The synthetic "KuCoin" wallet is an exchange account; a real address is self-custody.
    const isExchange = !wallet.address.startsWith('0x') && !wallet.address.startsWith('bc1')
    const label = isExchange ? wallet.address : `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    const kind: BtcLocation['kind'] = isExchange ? 'cex' : 'onchain'

    for (const chain of wallet.chains) {
      for (const token of chain.spot) addLocation(label, kind, add(token.symbol, token.usd ?? 0))
      for (const position of chain.defi) {
        if (position.health) continue // a lending liability line, not an asset
        let usd = 0
        if (position.bot?.weights?.length) {
          for (const weight of position.bot.weights) usd += add(weight.symbol, weight.usd)
        } else if (position.tokens?.length && position.tokens.every((t) => t.usd != null)) {
          for (const token of position.tokens) usd += add(token.symbol, token.usd as number)
        } else {
          usd += add(position.tokens?.[0]?.symbol, position.usd ?? 0)
        }
        addLocation(label, kind, usd)
      }
    }
  }

  for (const asset of ctx.manual) {
    const usd = manualUsd(asset, ctx)
    // Sats-denominated off-chain value is bitcoin whatever the asset is called.
    const counted = asset.ccy === 'sats' ? add('BTC', usd) : add(asset.name, usd)
    // Custodial means a third party holds the keys — not the same claim as cold storage, so it
    // gets its own bucket rather than being flattered into one.
    const custodial = asset.custody === 'custodial'
    addLocation(custodial ? asset.name : 'Off-chain', custodial ? 'custodial' : 'cold', counted)
  }

  const components = [...bySymbol.entries()]
    .map(([symbol, usd]) => ({ symbol, usd }))
    .sort((a, b) => b.usd - a.usd)
  const total = components.reduce((sum, c) => sum + c.usd, 0)
  const btcPrice = ctx.data.rates?.btc_usd
  return {
    usd: total,
    sats: typeof btcPrice === 'number' && btcPrice > 0 ? (total * 1e8) / btcPrice : null,
    components,
    locations: [...byLocation.values()].filter((l) => l.usd > 0).sort((a, b) => b.usd - a.usd),
  }
}

/** Stacking milestones, in sats. The next one up is the default target. */
const SATS_MILESTONES = [
  100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000,
  21_000_000, 50_000_000, 100_000_000,
]

/** The next milestone above `sats`; beyond the last one, the next whole bitcoin. */
export function nextSatsMilestone(sats: number): number {
  const next = SATS_MILESTONES.find((m) => m > sats)
  if (next) return next
  return Math.max(1, Math.ceil(sats / 100_000_000 + 1e-9)) * 100_000_000
}

// ---------------------------------------------------------------------------------------------
// Trading bots
// ---------------------------------------------------------------------------------------------

export interface BotRow {
  key: string
  label: string
  account: string
  category: string
  usd: number
  pnlUsd: number | null
  pnlPct: number | null
  marginUsd: number | null
  subBots: number
  info: DefiPosition['bot']
}

/**
 * Automated exchange strategies — rebalance and futures bots.
 *
 * A sibling to LP positions rather than a static holding: capital that runs on its own and needs
 * watching. Identified by carrying a `bot` block, which only `kucoin.py` emits.
 */
export function tradingBots(data: PortfolioData): BotRow[] {
  const rows: BotRow[] = []
  eachChain(data, (wallet, chain) => {
    for (const position of chain.defi) {
      if (!position.bot) continue
      rows.push({
        key: botKey(wallet.address, chain.chain, position),
        label: defiLabel(position),
        account: wallet.address,
        category: position.category ?? '',
        usd: position.usd ?? 0,
        pnlUsd: position.pnl_usd ?? null,
        pnlPct: position.pnl_pct ?? null,
        marginUsd: position.bot.margin_usd ?? null,
        subBots: position.bot.bots?.length ?? position.bot.count ?? 0,
        info: position.bot,
      })
    }
  })
  return rows.sort((a, b) => b.usd - a.usd)
}

export interface BotTotals {
  equity: number
  pnl: number
  margin: number
  subBots: number
  /** Return on invested capital: invested = equity − unrealized PnL. `null` when nothing is in. */
  returnPct: number | null
}

export function botTotals(rows: BotRow[]): BotTotals {
  const equity = rows.reduce((sum, r) => sum + r.usd, 0)
  const pnl = rows.reduce((sum, r) => sum + (r.pnlUsd ?? 0), 0)
  const invested = equity - pnl
  return {
    equity,
    pnl,
    margin: rows.reduce((sum, r) => sum + (r.marginUsd ?? 0), 0),
    subBots: rows.reduce((sum, r) => sum + r.subBots, 0),
    returnPct: invested > 0 ? (pnl / invested) * 100 : null,
  }
}

// ---------------------------------------------------------------------------------------------
// Cashflow — what the book pays out
// ---------------------------------------------------------------------------------------------

export interface Cashflow {
  /** Unclaimed fees and rewards sitting in positions right now. */
  claimable: number
  /** Modelled daily yield from positions reporting an APR. */
  perDay: number
  perYear: number
  /** Positions with something worth harvesting, biggest first. */
  harvest: LpRow[]
}

/**
 * Yield the portfolio is throwing off, and what is ready to collect.
 *
 * `perDay`/`perYear` are modelled from each position's own APR, so they are a projection and not
 * a measurement — a position with no APR contributes nothing rather than being guessed at.
 */
export function cashflow(rows: LpRow[], minHarvestUsd = 1): Cashflow {
  let perDay = 0
  let perYear = 0
  for (const row of rows) {
    const e = earnings(row)
    if (!e) continue
    perDay += e.perDay
    perYear += e.perYear
  }
  return {
    claimable: claimableUsd(rows),
    perDay,
    perYear,
    // `fees` is total claimable — swap fees plus gauge and campaign rewards — which is what you
    // actually collect when you harvest, so it is the right threshold to sort and filter on.
    harvest: rows.filter((r) => r.fees >= minHarvestUsd).sort((a, b) => b.fees - a.fees),
  }
}

export const HISTORY_WINDOWS = [
  { label: '7D', days: 7 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '1Y', days: 365 },
  { label: 'ALL', days: Number.POSITIVE_INFINITY },
] as const

// ---------------------------------------------------------------------------------------------
// Snowball — the basket tagged as the compounding engine
// ---------------------------------------------------------------------------------------------

/**
 * The snowball is a cross-cutting basket: a BTC wallet, an LP and a bot can all be in it. It is
 * not a tier and not a chain — it is the user's own statement of "this is the part that is
 * supposed to compound", so membership is tagged by hand and lives only on this device.
 *
 * Tag ids are built from the same key functions the rows use (`lpKey`, `botKey`), so a tag keeps
 * pointing at its position across refetches.
 */
export type SbKind = 'wallet' | 'lp' | 'bot' | 'manual'

export interface SbMember {
  id: string
  kind: SbKind
  label: string
  sub: string
  usd: number
  /** The bitcoin-denominated slice, so the sats readout counts only real BTC exposure. */
  btcUsd: number
  change: number | null
  /** Owning wallet, for the no-double-count rule. Absent for off-chain assets. */
  wallet?: string
}

/** Present-and-true means tagged; a removed tag is deleted rather than set false. */
export type SbTags = Record<string, true>

export const sbWalletId = (address: string): string => `w:${address}`
export const sbManualId = (name: string): string => `m:${name}`
export const sbLpId = (key: string): string => `lp:${key}`
export const sbBotId = (key: string): string => `bot:${key}`

/** BTC held as spot inside one wallet. Uses the BTC page's definition, so wrappers count. */
function walletBtcUsd(wallet: Wallet): number {
  let usd = 0
  for (const chain of wallet.chains) {
    for (const token of chain.spot) {
      if (isBtcSymbol(token.symbol)) usd += token.usd ?? 0
    }
  }
  return usd
}

/**
 * Everything that can be tagged, whether or not it is.
 *
 * Drives the source picker, and `snowballMembers` is this list filtered — one walk, so a source
 * that can be tagged is always one the basket can then count.
 */
export function snowballCandidates(ctx: Ctx): SbMember[] {
  const sources: SbMember[] = []

  for (const wallet of ctx.data.wallets) {
    sources.push({
      id: sbWalletId(wallet.address),
      kind: 'wallet',
      label: accountLabel(wallet.address),
      sub: 'whole wallet',
      usd: wallet.total,
      btcUsd: walletBtcUsd(wallet),
      change: null,
      wallet: wallet.address,
    })

    for (const chain of wallet.chains) {
      for (const position of chain.defi) {
        if (position.bot) {
          sources.push({
            id: sbBotId(botKey(wallet.address, chain.chain, position)),
            kind: 'bot',
            label: defiLabel(position),
            sub: position.category || 'bot',
            usd: position.usd ?? 0,
            btcUsd: 0,
            change: null,
            wallet: wallet.address,
          })
          continue
        }
        // Same discriminator `lpPositions` uses — lending carries `health`, not `rewards`.
        if (!('rewards' in position)) continue
        sources.push({
          id: sbLpId(lpKey(position, chain.chain)),
          kind: 'lp',
          label: lpPair(position),
          sub: `${position.protocol} · ${chain.chain}`,
          usd: position.usd ?? 0,
          btcUsd: 0,
          change: position.change24h ?? null,
          wallet: wallet.address,
        })
      }
    }
  }

  for (const asset of ctx.manual) {
    const usd = manualUsd(asset, ctx)
    // Sats-denominated value is bitcoin whatever the asset is called.
    const isBtc = asset.ccy === 'sats' || isBtcSymbol(asset.name)
    sources.push({
      id: sbManualId(asset.name),
      kind: 'manual',
      label: asset.name,
      sub: asset.kind === 'lightning' ? 'lightning' : 'off-chain',
      usd,
      btcUsd: isBtc ? usd : 0,
      change: null,
    })
  }

  return sources
}

/**
 * The tagged basket, largest first.
 *
 * A wallet tagged as a whole **swallows its own positions**: every LP and bot inside it is already
 * in `wallet.total`, so counting them again would inflate the basket by whatever share is
 * deployed. Untagging the wallet brings the individual positions back on their own tags.
 *
 * Unlike the original, sub-bots are not tagged individually — a futures strategy is tagged as one
 * row, matching how the Bots page presents it.
 */
export function snowballMembers(ctx: Ctx, tags: SbTags): SbMember[] {
  const sources = snowballCandidates(ctx)
  const wholeWallets = new Set(
    sources.filter((s) => s.kind === 'wallet' && tags[s.id]).map((s) => s.wallet as string),
  )

  return sources
    .filter((s) => {
      if (!tags[s.id]) return false
      if (s.kind !== 'wallet' && s.wallet && wholeWallets.has(s.wallet)) return false
      // A zero-value source is a position that has been closed; it stays tagged (re-entering the
      // same pool rejoins the basket) but contributes nothing, so it is not shown as a member.
      return s.usd > 0
    })
    .sort((a, b) => b.usd - a.usd)
}

export function snowballUsd(ctx: Ctx, tags: SbTags): number {
  return sumUsd(snowballMembers(ctx, tags))
}

/**
 * Change over the last seven days of the basket's own series.
 *
 * `null` when there is nothing to compare against — one point, or every point on the same day.
 * A day-old install must say "not yet", never "+$0".
 */
export function sbWeekDelta(history: NwPoint[]): number | null {
  if (history.length < 2) return null
  const latest = history[history.length - 1]
  const base = history.find((p) => p.d >= latest.d - 7 * DAY_MS) ?? history[0]
  return base.d === latest.d ? null : latest.v - base.v
}

/**
 * Feed rate: USD per month implied by the realized slope across the whole series.
 *
 * Under three days of history the slope is noise rather than a trend, so it is withheld — a
 * projection built on two adjacent points would swing wildly with the market.
 */
export function sbMonthly(history: NwPoint[]): number | null {
  if (history.length < 2) return null
  const spanDays = (history[history.length - 1].d - history[0].d) / DAY_MS
  if (spanDays < 3) return null
  return ((history[history.length - 1].v - history[0].v) / spanDays) * (365.25 / 12)
}
