/**
 * Where the wealth surfaces get their data.
 *
 * The interface is the seam: `api-wealth-repository.ts` implements it against the Rust endpoints
 * and `mockWealthSource` implements it for a demo session, and `use-wealth.ts` picks between them
 * from the app-wide data mode — no component knows which one it has. The mock is shaped to
 * exercise the awkward cases — an out-of-range LP, a borrow position, a shared campaign claim, an
 * off-chain asset — because those are what break, and it is what the render tests run against.
 */

import type { ManualAsset, NwPoint, PortfolioData } from './types'

export interface WealthDataSource {
  getPortfolio(): Promise<PortfolioData>
  getHistory(): Promise<NwPoint[]>
  getManualAssets(): Promise<ManualAsset[]>
}

const DAY_MS = 86_400_000

/** A deterministic pseudo-random walk — a fixed seed keeps the mock stable between reloads. */
function history(days: number, end: number): NwPoint[] {
  const points: NwPoint[] = []
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS
  let value = end * 0.72
  let seed = 42
  for (let i = days; i >= 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const drift = ((seed / 2147483648) - 0.45) * 0.035
    value = Math.max(1000, value * (1 + drift) + (end - value) * 0.02)
    const v = i === 0 ? end : Math.round(value * 100) / 100
    points.push({
      d: today - i * DAY_MS,
      v,
      tiers: { store: v * 0.46, business: v * 0.38, trading: v * 0.16 },
      debt: 8_400,
    })
  }
  return points
}

const MOCK_TOTAL = 184_320.55

const MOCK_PORTFOLIO: PortfolioData = {
  total: MOCK_TOTAL,
  fetched_at: Date.now() / 1000 - 240,
  rates: { usd: 1, thb: 32.4, btc_usd: 96_500 },
  wallets: [
    {
      address: '0x1234567890abcdef1234567890abcdef12345678',
      total: 151_204.31,
      chains: [
        {
          chain: 'ethereum',
          usd: 82_140.2,
          spot: [
            { symbol: 'ETH', amount: 14.2, usd: 48_280.0, change24h: 2.4, price: 3400, category: 'Native' },
            { symbol: 'WBTC', amount: 0.21, usd: 20_265.0, change24h: -1.1, price: 96_500 },
            { symbol: 'USDC', amount: 12_450.2, usd: 12_450.2, change24h: 0.01, price: 1 },
            { symbol: 'AAVE', amount: 12.5, usd: 1_145.0, change24h: 5.2 },
            { symbol: 'SHIBGROK', amount: 4_000_000, usd: 0.42, change24h: null },
          ],
          defi: [
            {
              protocol: 'Uniswap v3',
              category: 'Liquidity Pool',
              name: 'ETH/USDC',
              id: '482913',
              via: null,
              usd: 24_180.5,
              tokens: [
                { symbol: 'ETH', amount: 3.55, usd: 12_070.0 },
                { symbol: 'USDC', amount: 12_110.5, usd: 12_110.5 },
              ],
              rewards: [
                { symbol: 'ETH', amount: 0.031, usd: 105.4 },
                { symbol: 'USDC', amount: 98.2, usd: 98.2 },
              ],
              rewards_usd: 203.6,
              swap_fees_usd: 203.6,
              in_range: true,
              change24h: 1.2,
              apr: 18.4,
              pool_type: 'pool',
              tick_spacing: 60,
              price_band: { lower: 2_950, upper: 3_820, cur: 3_400, base: 'ETH', quote: 'USDC', full: false },
              range_pct: { min: -13.2, max: 12.4, width: 25.6 },
              deployed_at: new Date(Date.now() - 42 * DAY_MS).toISOString(),
              updated_at: new Date(Date.now() - 3 * DAY_MS).toISOString(),
              last_action: 'harvested',
              last_harvest_at: new Date(Date.now() - 12 * DAY_MS).toISOString(),
              cycle_start: Math.floor((Date.now() - 12 * DAY_MS) / 1000),
              in_range_secs: Math.floor((12 * DAY_MS * 0.93) / 1000),
            },
            {
              protocol: 'Aave v3',
              category: 'Borrowing',
              name: 'ETH collateral / USDC debt',
              id: null,
              via: null,
              usd: null,
              tokens: [
                { symbol: 'ETH', amount: 6.0, usd: 20_400, side: 'supply' },
                { symbol: 'USDC', amount: 8_400, usd: 8_400, side: 'borrow' },
              ],
              health: { hf: 1.94, ltv: 0.41, liq_threshold: 0.83, collateral_usd: 20_400, debt_usd: 8_400 },
            },
          ],
        },
        {
          chain: 'base',
          usd: 41_820.11,
          spot: [
            { symbol: 'ETH', amount: 4.1, usd: 13_940.0, change24h: 2.4 },
            { symbol: 'USDC', amount: 9_200.0, usd: 9_200.0, change24h: 0 },
            { symbol: 'AERO', amount: 8_400, usd: 6_720.0, change24h: -3.8 },
          ],
          defi: [
            {
              protocol: 'Aerodrome',
              category: 'Liquidity Pool',
              name: 'AERO/USDC',
              id: '77120',
              via: '0x827922686190790b37229fd06084350E74485b72',
              usd: 11_960.11,
              tokens: [
                { symbol: 'AERO', amount: 7_100, usd: 5_680.0 },
                { symbol: 'USDC', amount: 6_280.11, usd: 6_280.11 },
              ],
              rewards: [
                { symbol: 'AERO', amount: 412.5, usd: 330.0 },
                // Wallet-level campaign claim — repeated on the HyperEVM farm below with the same
                // claim id, so the dedup path is exercised.
                { symbol: 'OP', amount: 120, usd: 84.0, shared: true, claim: 'campaign-op-q3' },
              ],
              rewards_usd: 414.0,
              swap_fees_usd: 330.0,
              in_range: false,
              change24h: -2.9,
              apr: 42.1,
              pool_type: 'farm',
              tick_spacing: 200,
              price_band: { lower: 0.92, upper: 1.14, cur: 0.79, base: 'AERO', quote: 'USDC', full: false },
              deployed_at: new Date(Date.now() - 18 * DAY_MS).toISOString(),
              updated_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
              last_action: 'deposited',
              cycle_start: Math.floor((Date.now() - 18 * DAY_MS) / 1000),
              in_range_secs: Math.floor((18 * DAY_MS * 0.61) / 1000),
            },
          ],
        },
        {
          chain: 'hyperevm',
          usd: 27_244.0,
          spot: [{ symbol: 'HYPE', amount: 620, usd: 17_360.0, change24h: 7.9 }],
          defi: [
            {
              protocol: 'Hyperswap',
              category: 'Liquidity Pool',
              name: 'HYPE/USDT',
              id: '1042',
              via: '0x233d9067677dcf1a161954d45b4c965b9d567168',
              usd: 9_884.0,
              tokens: [
                { symbol: 'HYPE', amount: 176, usd: 4_928.0 },
                { symbol: 'USDT', amount: 4_956.0, usd: 4_956.0 },
              ],
              rewards: [
                { symbol: 'HYPE', amount: 2.4, usd: 67.2 },
                { symbol: 'OP', amount: 120, usd: 84.0, shared: true, claim: 'campaign-op-q3' },
              ],
              rewards_usd: 151.2,
              in_range: true,
              change24h: 6.1,
              apr: 61.7,
              pool_type: 'farm',
              price_band: { lower: 21.0, upper: 34.0, cur: 28.0, base: 'HYPE', quote: 'USDT', full: false },
              deployed_at: new Date(Date.now() - 9 * DAY_MS).toISOString(),
              updated_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
              last_action: 'rebalanced',
              cycle_start: Math.floor((Date.now() - 9 * DAY_MS) / 1000),
              in_range_secs: Math.floor((9 * DAY_MS * 0.99) / 1000),
            },
          ],
        },
      ],
    },
    {
      address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      total: 21_230.0,
      chains: [
        {
          chain: 'bitcoin',
          usd: 21_230.0,
          spot: [{ symbol: 'BTC', amount: 0.22, usd: 21_230.0, change24h: -1.1, price: 96_500 }],
          defi: [],
        },
      ],
    },
    {
      address: 'kucoin',
      total: 11_886.24,
      chains: [
        {
          chain: 'kucoin',
          usd: 11_886.24,
          spot: [{ symbol: 'USDT', amount: 3_886.24, usd: 3_886.24, change24h: 0 }],
          defi: [
            {
              protocol: 'KuCoin',
              category: 'Rebalance',
              name: 'BTC/ETH rebalance bot',
              id: 'bot-1',
              via: null,
              usd: 8_000.0,
              tokens: [
                { symbol: 'BTC', amount: 0.05, usd: 4_825.0 },
                { symbol: 'ETH', amount: 0.93, usd: 3_175.0 },
              ],
              change24h: 0.8,
              pnl_usd: 412.0,
              pnl_pct: 5.4,
              bot: {
                kind: 'rebalance',
                status: 'running',
                count: 2,
                margin_usd: 0,
                weights: [
                  { symbol: 'BTC', amount: 0.05, usd: 4_825.0, pct: 60.3 },
                  { symbol: 'ETH', amount: 0.93, usd: 3_175.0, pct: 39.7 },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
}

const MOCK_MANUAL: ManualAsset[] = [
  { name: 'Cold storage BTC', value: 14_000_000, ccy: 'sats', tier: 'store', custody: 'cold', note: 'Hardware wallet' },
  { name: 'Kinesis gold (KAU)', kind: 'kgold', value: 4_200, ccy: 'usd', tier: 'store', code: 'KAU' },
  { name: 'Lightning channel', kind: 'lightning', value: 2_400_000, ccy: 'sats', tier: 'trading', custody: 'custodial' },
  { name: 'THB savings', value: 180_000, ccy: 'thb', tier: 'business', note: 'Bangkok bank' },
]

function delay<T>(value: T, ms = 320): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/** In-memory source used until the API lands. The delay makes loading states real in dev. */
export const mockWealthSource: WealthDataSource = {
  getPortfolio: () => delay(MOCK_PORTFOLIO),
  getHistory: () => delay(history(400, MOCK_TOTAL)),
  getManualAssets: () => delay(MOCK_MANUAL),
}

/** Renders the empty/onboarding state — no wallets configured yet. */
export const emptyWealthSource: WealthDataSource = {
  getPortfolio: () => delay({ wallets: [], total: 0, rates: null, fetched_at: Date.now() / 1000 }),
  getHistory: () => delay([]),
  getManualAssets: () => delay([]),
}
