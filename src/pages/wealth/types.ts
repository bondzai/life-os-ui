/**
 * The wealth data contract.
 *
 * Mirrors `wallet-portfolio/web/src/lib/types.ts` — the JSON shape the Rust backend will serve.
 * It is duplicated here rather than imported because that app is a separate repo; when the
 * backend lands, this file is what the response is validated against, so keep it in step with
 * the oracle and do NOT add fields the API does not actually send.
 */

export type Tier = 'store' | 'business' | 'trading'

export interface TokenAmt {
  symbol: string
  amount: number
  usd?: number
  /** lending legs only: which side of the book this token sits on */
  side?: 'supply' | 'borrow'
  /** reward only: a wallet-level claim shown on every earning position (e.g. Nest) */
  shared?: boolean
  /** reward only: claim id — dedupe by this so a shared claim counts once in totals */
  claim?: string
}

export interface PriceBand {
  lower: number | null
  upper: number | null
  cur: number | null
  base: string
  quote: string
  full: boolean
}

export interface BotWeight {
  symbol: string
  amount: number
  usd: number
  pct: number
}

export interface SubBot {
  /** stable KuCoin sub-account handle — anchors user-set labels */
  id?: string | null
  usd: number
  pnl_usd: number
  pnl_pct: number
  margin: number
}

export interface BotInfo {
  kind: string
  status: string
  count?: number
  weights?: BotWeight[]
  margin_usd?: number
  margin_pct?: number
  bots?: SubBot[]
}

/** A borrow position's risk snapshot. `hf` is null when there is no debt (not liquidatable). */
export interface LendingHealth {
  hf: number | null
  ltv: number
  liq_threshold: number
  collateral_usd: number
  debt_usd: number
}

export interface DefiPosition {
  protocol: string
  category: string
  name: string
  id: string | null
  via: string | null
  tokens: TokenAmt[]
  usd: number | null
  in_range?: boolean
  rewards?: TokenAmt[]
  rewards_usd?: number
  /** swap fees alone (rewards_usd also includes gauge + campaign rewards) */
  swap_fees_usd?: number
  change24h?: number | null
  price_band?: PriceBand
  tick_spacing?: number
  bot?: BotInfo
  pnl_usd?: number
  pnl_pct?: number
  /** real APR from vfat (farm.snapshot.apr) */
  apr?: number
  /** price band, % from spot */
  range_pct?: { min: number; max: number; width: number }
  /** ISO — first on-chain action (mint/deposit) */
  deployed_at?: string
  /** ISO — latest action */
  updated_at?: string
  /** e.g. deposited | rebalanced | harvested */
  last_action?: string
  /** ISO — latest harvest action (anchors the perf cycle) */
  last_harvest_at?: string
  /** epoch secs the current fee cycle began (last harvest, else deploy) */
  cycle_start?: number
  /** real in-range time this cycle — sampled server-side 24/7 */
  in_range_secs?: number
  /** 'pool' (swap-fee LP) | 'farm' (earns reward tokens) */
  pool_type?: string
  /** lending/borrow positions (category 'Borrowing') */
  health?: LendingHealth
}

/** A flattened borrow position for the health UI (one per protocol/chain borrow). */
export interface LendRow {
  key: string
  protocol: string
  chain: string
  hf: number | null
  ltv: number
  liq_threshold: number
  collateral_usd: number
  debt_usd: number
  /** exact net-worth contribution (Aave −debt; Compound/Morpho collateral−debt) */
  net_usd: number
  /** underlying supply/borrow legs (symbol + amount), for the compact row */
  tokens: TokenAmt[]
}

export interface SpotToken {
  symbol: string
  amount: number
  usd: number
  change24h?: number | null
  price?: number
  coin?: string
  category?: string
}

export interface ChainBucket {
  chain: string
  usd: number
  spot: SpotToken[]
  defi: DefiPosition[]
}

export interface Wallet {
  address: string
  total: number
  chains: ChainBucket[]
}

export interface Rates {
  usd?: number
  /** THB per 1 USD */
  thb?: number
  /** USD per 1 BTC */
  btc_usd?: number
  [k: string]: number | undefined | null
}

/** A point on the net-worth history series. */
export interface NwPoint {
  d: number
  v: number
  /** per-tier USD at snapshot time (for per-tier P&L over time) */
  tiers?: Record<string, number>
  /** total borrowed at snapshot time */
  debt?: number
}

export interface PortfolioData {
  wallets: Wallet[]
  total: number
  rates: Rates | null
  fetched_at: number
}

/** One configured address the book is built from (`/api/wealth/wallets`). */
export interface WalletEntry {
  id: string
  address: string
  label: string | null
  /** Resolved server-side by the same classifier the chain fan-out uses. */
  kind: 'evm' | 'bitcoin' | 'solana'
  created_at: number
}

/**
 * The wallet list, and where it came from.
 *
 * `source` matters: an empty list plus `env` means the addresses still come from `ALERT_WALLETS`
 * and adding one here takes over, which is a different thing to say than "you have no wallets".
 */
export interface WalletList {
  wallets: WalletEntry[]
  source: 'db' | 'env'
  /** What the fan-out will actually read, whichever source won. */
  effective: string[]
}

export interface ManualAsset extends ManualAssetInput {
  /** Server-assigned. Absent from the browser-local lists this replaced — see the repository. */
  id: string
}

/** The writable half of a [[ManualAsset]] — what an editor form produces. */
export interface ManualAssetInput {
  name: string
  kind?: 'jlp' | 'kgold' | 'lightning'
  value?: number
  ccy?: 'usd' | 'thb' | 'sats'
  units?: number
  code?: string
  tier: Tier
  chain?: string
  note?: string
  /** BTC custody: self-custody cold (default) vs a third party holds it (Lightning/WoS) */
  custody?: 'cold' | 'custodial'
}

/**
 * One pool from vfat's discovery feed — `GET /api/wealth/opportunities`.
 *
 * The same shape the yield radar serves, deliberately: a suggestion is a suggestion whether it was
 * found by comparing against what the wallet holds or by asking what exists.
 */
export interface YieldOpportunity {
  chain_id: number | null
  chain: string
  pair: string
  tokens: string[]
  protocol: string | null
  url: string | null
  /** Percent, on vfat's own scale — `72.4` is 72.4%, not 0.724. */
  apr: number
  tvl: number
  /** Hundredths of a basis point, as the pool reports it: `3000` is a 0.3% pool. */
  fee: number | null
}

/**
 * The filters the server actually applied, echoed back.
 *
 * Worth carrying because most of them are defaults the page never sent — `min_tvl` in particular
 * is a server-side floor, and a board that hides its own floor invites "why is this pool missing".
 */
export interface OpportunityFilters {
  chains: number[]
  min_apr: number | null
  max_apr: number | null
  min_tvl: number
  sort: string
  limit: number
}

export interface OpportunityBoard {
  opportunities: YieldOpportunity[]
  filters: OpportunityFilters
}

/** How far behind vfat's own view of one chain is — `GET /api/wealth/vfat-status`. */
export interface ChainFreshness {
  chain_id: number
  chain: string
  block_lag: number
  time_lag_secs: number
  lagging_pipeline: string | null
  behind: boolean
}

export interface VfatStatus {
  /** `false` means the endpoint could not be read — which is not the same as every chain current. */
  checked: boolean
  behind: number
  worst_lag_secs: number | null
  chains: ChainFreshness[]
}

// ---- flattened views used by the UI ----

export interface Holding {
  label: string
  usd: number
  tier: Tier
  chain: string
  change: number | null
  /** spot balance, DeFi position (LP/bot), or off-chain manual asset */
  kind?: 'spot' | 'defi' | 'manual'
  manual?: boolean
}

export interface LpRow {
  key: string
  protocol: string
  pair: string
  chain: string
  value: number
  /** total claimable: swap fees + gauge + campaign rewards (full value) */
  fees: number
  /** swap fees only — the realized fee-APR basis (excludes lumpy campaign claims) */
  swapFees: number
  in_range: boolean | null
  id: string | null
  via: string | null
  cl: number | null
  band: PriceBand | null
  toks: TokenAmt[]
  feeToks: TokenAmt[]
  apr: number | null
  /** realized PnL in USD since the position opened — vfat's `totalPnlUsd`; null = not reported */
  pnlUsd: number | null
  /** the same as a return on gross contributions — vfat's `roiPercent`, not derived from pnlUsd */
  pnlPct: number | null
  rangePct: { min: number; max: number; width: number } | null
  deployedAt: string | null
  updatedAt: string | null
  lastAction: string | null
  poolType: string | null
  /** real in-range time this cycle (server-tracked); null = not tracked yet */
  inRangeSecs: number | null
  /** epoch secs the current fee cycle began (last harvest, else deploy) */
  cycleStart: number | null
  /** whether the cycle is anchored to a harvest (vs the original deploy) */
  harvested: boolean
}

export type Currency = 'usd' | 'thb' | 'sats'

/**
 * The valuation & mood models behind Radar (`/api/wealth/sentiment`).
 *
 * Every field is optional: each model is a separate keyless read of a public source, and one
 * being down must not take the panel with it.
 */
export interface Sentiment {
  fear_greed?: { value: number; classification: string }
  mvrv_zscore?: { value: number; label: string; color?: string }
  btc_rainbow?: { ratio: number; label: string; color?: string; fair_usd?: number }
  sopr?: { value: number; label: string; color?: string }
  puell?: { value: number; label: string; color?: string }
  fetched_at?: number
}

/** One entry in the LLM analysis journal (`/api/wealth/analyses`). */
export interface Analysis {
  id: string
  scope: string
  kind: string
  source: string
  title: string | null
  summary: string | null
  body: string | null
  version: number
  created_at: number
  superseded_by: string | null
  archived: boolean
}

/**
 * Alert configuration and the live state of the background sweep (`/api/wealth/alerts`).
 *
 * The four poller fields are reported inert — `running: false`, the rest null — when the loop was
 * never started, which is the honest answer rather than a fabricated timestamp.
 */
export interface AlertStatus {
  configured: boolean
  can_send: boolean
  wallets: number
  interval: number
  fee_threshold: number | null
  hf_alert: number | null
  report_ccy: string
  digest_enabled: boolean
  digest_hour: number | null
  digest_last: string | null
  overrides: Record<string, unknown>
  last_check: number | null
  watching: number | null
  last_error: string | null
  running: boolean
}
