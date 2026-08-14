/**
 * Tests for the wealth derivations.
 *
 * These cover the accounting rules that are invisible on screen when they break: debt netting,
 * dust filtering, and claim de-duplication all produce a plausible-looking number when wrong,
 * which is exactly why they are pinned here rather than eyeballed.
 */

import { describe, expect, it } from 'vitest'
import {
  claimableByToken,
  claimableUsd,
  cyclePerf,
  classify,
  flatList,
  EMPTY_FILTERS,
  groupRows,
  holdings,
  lendingNet,
  lendingPositions,
  lpPositions,
  netWorth,
  portfolioChange,
  rangeInfo,
  sortLp,
  tierTotals,
  windowPerf,
  type Ctx,
} from './derive'
import type { DefiPosition, LpRow, PortfolioData, SpotToken } from './types'

function spot(symbol: string, usd: number, change24h: number | null = null): SpotToken {
  return { symbol, amount: usd, usd, change24h }
}

function ctxOf(defi: DefiPosition[] = [], spotTokens: SpotToken[] = [], dustUsd = 0): Ctx {
  const data: PortfolioData = {
    total: 0,
    fetched_at: 0,
    rates: { thb: 32, btc_usd: 100_000 },
    wallets: [
      {
        address: '0xabc0000000000000000000000000000000000001',
        total: 0,
        chains: [{ chain: 'ethereum', usd: 0, spot: spotTokens, defi }],
      },
    ],
  }
  return { data, manual: [], dustUsd }
}

const lendingPosition: DefiPosition = {
  protocol: 'Aave v3',
  category: 'Borrowing',
  name: 'collateral',
  id: null,
  via: null,
  tokens: [],
  usd: null,
  health: { hf: 1.8, ltv: 0.4, liq_threshold: 0.8, collateral_usd: 20_000, debt_usd: 8_000 },
}

describe('classify', () => {
  it('routes by category before symbol, so a BTC perp is a trade not a store', () => {
    expect(classify({ symbol: 'BTC', category: 'Perps' })).toBe('trading')
    expect(classify({ symbol: 'BTC' })).toBe('store')
    expect(classify({ symbol: 'WETH' })).toBe('store')
    expect(classify({ symbol: 'USDC' })).toBe('business')
    expect(classify({ symbol: 'ETH', category: 'Liquidity Pool' })).toBe('business')
  })

  it('is case-insensitive about symbols', () => {
    expect(classify({ symbol: 'wbtc' })).toBe('store')
  })
})

describe('net worth', () => {
  it('subtracts Aave debt only, since its collateral already shows up as spot', () => {
    const ctx = ctxOf([lendingPosition], [spot('aEthWETH', 20_000)])
    // Gross holdings see the 20k collateral; lending contributes -8k debt, never +12k.
    expect(lendingNet(ctx.data)).toBe(-8_000)
    expect(netWorth(ctx)).toBe(12_000)
  })

  it('nets collateral minus debt for in-contract protocols', () => {
    const morpho: DefiPosition = {
      ...lendingPosition,
      protocol: 'Morpho',
      health: { hf: 2, ltv: 0.3, liq_threshold: 0.8, collateral_usd: 5_000, debt_usd: 1_000 },
    }
    expect(lendingNet(ctxOf([morpho]).data)).toBe(4_000)
  })

  it('excludes lending positions from holdings so nothing is double counted', () => {
    const rows = holdings(ctxOf([lendingPosition], [spot('aEthWETH', 20_000)]))
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe('aEthWETH')
  })

  it('exposes a borrow row for the health UI', () => {
    const [row] = lendingPositions(ctxOf([lendingPosition]).data)
    expect(row.hf).toBe(1.8)
    expect(row.debt_usd).toBe(8_000)
    expect(row.net_usd).toBe(-8_000)
  })
})

describe('dust filtering', () => {
  const airdrop = spot('SCAMCOIN', 0.4)
  const smallLp: DefiPosition = {
    protocol: 'Uniswap v3', category: 'Liquidity Pool', name: 'tiny', id: '1', via: null,
    tokens: [{ symbol: 'ETH', amount: 0.001 }], usd: 0.5, rewards: [],
  }

  it('hides dust spot balances above the threshold', () => {
    const rows = holdings(ctxOf([], [airdrop, spot('ETH', 5_000)], 1))
    expect(rows.map((r) => r.label)).toEqual(['ETH'])
  })

  it('never dust-filters a DeFi position — the user opened it deliberately', () => {
    const rows = holdings(ctxOf([smallLp], [airdrop], 1))
    expect(rows.map((r) => r.label)).toContain('Uniswap v3 · tiny')
  })

  it('drops zero and negative values regardless of threshold', () => {
    const rows = holdings(ctxOf([], [spot('ZERO', 0)], 0))
    expect(rows).toHaveLength(0)
  })
})

describe('tier totals and change', () => {
  it('splits by tier', () => {
    const rows = holdings(ctxOf([], [spot('BTC', 1_000), spot('USDC', 500)]))
    const totals = tierTotals(rows)
    expect(totals.store).toBe(1_000)
    expect(totals.business).toBe(500)
    expect(totals.trading).toBe(0)
  })

  it('weights 24h change by position size, not by count', () => {
    const rows = holdings(ctxOf([], [spot('BTC', 9_000, 10), spot('USDC', 1_000, -10)]))
    // A naive mean would say 0%; the real blend is dominated by the 9k position.
    expect(portfolioChange(rows)).toBeCloseTo(8, 6)
  })

  it('ignores holdings with no change data instead of treating them as flat', () => {
    const rows = holdings(ctxOf([], [spot('BTC', 1_000, 10), spot('USDC', 9_000, null)]))
    expect(portfolioChange(rows)).toBe(10)
  })

  it('returns null when nothing reports a change', () => {
    expect(portfolioChange(holdings(ctxOf([], [spot('BTC', 1_000, null)])))).toBeNull()
  })
})

describe('flatList', () => {
  it('keeps same-symbol balances separate per chain and sorts by value', () => {
    const data: PortfolioData = {
      total: 0, fetched_at: 0, rates: null,
      wallets: [{
        address: '0xabc0000000000000000000000000000000000001', total: 0,
        chains: [
          { chain: 'ethereum', usd: 0, spot: [spot('USDC', 100)], defi: [] },
          { chain: 'base', usd: 0, spot: [spot('USDC', 300)], defi: [] },
        ],
      }],
    }
    const rows = flatList({ data, manual: [], dustUsd: 0 }, EMPTY_FILTERS)
    expect(rows).toHaveLength(2)
    expect(rows[0].usd).toBe(300)
    expect(rows.map((r) => r.chain)).toEqual(['base', 'ethereum'])
  })

  it('filters by search across symbol and chain', () => {
    const ctx = ctxOf([], [spot('USDC', 100), spot('ETH', 200)])
    expect(flatList(ctx, { ...EMPTY_FILTERS, query: 'usdc' }).map((r) => r.label)).toEqual(['USDC'])
    expect(flatList(ctx, { ...EMPTY_FILTERS, query: 'ethereum' })).toHaveLength(2)
  })

  it('applies the stricter of the page minimum and the global dust floor', () => {
    const ctx = ctxOf([], [spot('SMALL', 5), spot('BIG', 500)], 10)
    expect(flatList(ctx, { ...EMPTY_FILTERS, minUsd: 0 }).map((r) => r.label)).toEqual(['BIG'])
    expect(flatList(ctx, { ...EMPTY_FILTERS, minUsd: 1_000 })).toHaveLength(0)
  })

  it('labels the KuCoin pseudo-wallet rather than truncating it as an address', () => {
    const data: PortfolioData = {
      total: 0, fetched_at: 0, rates: null,
      wallets: [{ address: 'kucoin', total: 0, chains: [{ chain: 'kucoin', usd: 0, spot: [spot('USDT', 10)], defi: [] }] }],
    }
    expect(flatList({ data, manual: [], dustUsd: 0 }, EMPTY_FILTERS)[0].account).toBe('KuCoin')
  })

  it('groups and orders groups by size', () => {
    const data: PortfolioData = {
      total: 0, fetched_at: 0, rates: null,
      wallets: [{
        address: '0xabc0000000000000000000000000000000000001', total: 0,
        chains: [
          { chain: 'ethereum', usd: 0, spot: [spot('USDC', 100)], defi: [] },
          { chain: 'base', usd: 0, spot: [spot('USDC', 300)], defi: [] },
        ],
      }],
    }
    const groups = groupRows(flatList({ data, manual: [], dustUsd: 0 }, EMPTY_FILTERS), 'chain')
    expect(groups.map((g) => g.key)).toEqual(['base', 'ethereum'])
    expect(groups[0].usd).toBe(300)
  })
})

describe('manual assets', () => {
  it('converts sats and THB into USD', () => {
    const ctx: Ctx = {
      ...ctxOf(),
      manual: [
        { name: 'Cold BTC', value: 100_000_000, ccy: 'sats', tier: 'store' },
        { name: 'Baht', value: 32_000, ccy: 'thb', tier: 'business' },
      ],
    }
    const rows = holdings(ctx)
    expect(rows.find((r) => r.label === 'Cold BTC')?.usd).toBe(100_000)
    expect(rows.find((r) => r.label === 'Baht')?.usd).toBe(1_000)
  })
})

describe('LP positions', () => {
  const lp: DefiPosition = {
    protocol: 'Uniswap v3', category: 'Liquidity Pool', name: 'ETH/USDC', id: '1', via: null,
    tokens: [{ symbol: 'ETH', amount: 1 }, { symbol: 'USDC', amount: 0 }],
    usd: 1_000, rewards: [{ symbol: 'ETH', amount: 0.01, usd: 30 }],
    rewards_usd: 50, swap_fees_usd: 30, in_range: true, apr: 12,
  }

  it('only picks up positions that carry rewards, not lending or plain balances', () => {
    expect(lpPositions(ctxOf([lp, lendingPosition]).data)).toHaveLength(1)
  })

  it('distinguishes total rewards from swap fees', () => {
    const [row] = lpPositions(ctxOf([lp]).data)
    expect(row.fees).toBe(50)
    expect(row.swapFees).toBe(30)
  })

  it('falls back to total rewards when swap fees are not broken out', () => {
    const [row] = lpPositions(ctxOf([{ ...lp, swap_fees_usd: undefined }]).data)
    expect(row.swapFees).toBe(50)
  })

  it('drops zero-amount token legs', () => {
    const [row] = lpPositions(ctxOf([lp]).data)
    expect(row.toks.map((t) => t.symbol)).toEqual(['ETH'])
  })

  it('derives the harvested flag from the presence of a harvest timestamp', () => {
    expect(lpPositions(ctxOf([lp]).data)[0].harvested).toBe(false)
    const harvested = lpPositions(ctxOf([{ ...lp, last_harvest_at: '2026-01-01T00:00:00Z' }]).data)[0]
    expect(harvested.harvested).toBe(true)
  })
})

describe('claimable rewards', () => {
  const shared = { symbol: 'OP', amount: 10, usd: 100, shared: true, claim: 'campaign-1' }
  const withShared = (id: string): DefiPosition => ({
    protocol: 'Aerodrome', category: 'Liquidity Pool', name: `pool-${id}`, id, via: null,
    tokens: [], usd: 100,
    rewards: [{ symbol: 'AERO', amount: 5, usd: 25 }, shared],
    rewards_usd: 125,
  })

  it('counts a wallet-level claim once even when several positions report it', () => {
    const rows = lpPositions(ctxOf([withShared('a'), withShared('b')]).data)
    // Naive summing gives 250; the shared 100 must only land once → 25 + 25 + 100.
    expect(claimableUsd(rows)).toBe(150)
  })

  it('dedupes per token too, and orders by value', () => {
    const rows = lpPositions(ctxOf([withShared('a'), withShared('b')]).data)
    const byToken = claimableByToken(rows)
    expect(byToken.map((t) => t.symbol)).toEqual(['OP', 'AERO'])
    expect(byToken.find((t) => t.symbol === 'OP')?.usd).toBe(100)
    expect(byToken.find((t) => t.symbol === 'AERO')?.usd).toBe(50)
  })
})

describe('range geometry', () => {
  const base: LpRow = {
    key: 'k', protocol: 'p', pair: 'ETH/USDC', chain: 'ethereum', value: 100, fees: 0, swapFees: 0,
    in_range: true, id: null, via: null, cl: null,
    band: { lower: 100, upper: 200, cur: 150, base: 'ETH', quote: 'USDC', full: false },
    toks: [], feeToks: [], apr: null, rangePct: null, deployedAt: null, updatedAt: null,
    lastAction: null, poolType: null, inRangeSecs: null, cycleStart: null, harvested: false,
  }

  it('places spot within the band', () => {
    expect(rangeInfo(base)?.posPct).toBeCloseTo(50, 6)
  })

  it('trusts in_range rather than recomputing it from the bounds', () => {
    // Price sits inside the band, but the server says out — the server wins.
    expect(rangeInfo({ ...base, in_range: false })?.out).toBe(true)
  })

  it('returns null for full-range and malformed bands', () => {
    expect(rangeInfo({ ...base, band: { ...base.band!, full: true } })).toBeNull()
    expect(rangeInfo({ ...base, band: null })).toBeNull()
    expect(rangeInfo({ ...base, band: { ...base.band!, upper: 50 } })).toBeNull()
  })

  it('sorts out-of-range positions first regardless of direction', () => {
    const inRange = { ...base, key: 'in' }
    const outRange = { ...base, key: 'out', in_range: false }
    expect(sortLp([inRange, outRange], 'health', 'asc').map((r) => r.key)).toEqual(['out', 'in'])
    expect(sortLp([inRange, outRange], 'health', 'desc').map((r) => r.key)).toEqual(['out', 'in'])
  })

  it('reports the share of the fee cycle spent in range', () => {
    const now = 1_000_000_000_000
    const row = { ...base, cycleStart: now / 1000 - 100, inRangeSecs: 50, harvested: true }
    const perf = cyclePerf(row, now)
    expect(perf?.pct).toBeCloseTo(50, 4)
    expect(perf?.anchor).toBe('harvest')
  })

  it('caps in-range share at 100% when sampling overshoots', () => {
    const now = 1_000_000_000_000
    const row = { ...base, cycleStart: now / 1000 - 100, inRangeSecs: 140 }
    expect(cyclePerf(row, now)?.pct).toBe(100)
  })
})

describe('history window', () => {
  const day = 86_400_000
  const today = Math.floor(Date.now() / day) * day
  const series = [
    { d: today - 90 * day, v: 100 },
    { d: today - 30 * day, v: 150 },
    { d: today - 2 * day, v: 180 },
    { d: today, v: 200 },
  ]

  it('measures from the first point inside the window', () => {
    const perf = windowPerf(series, 30)
    expect(perf?.delta).toBe(50)
    expect(perf?.pct).toBeCloseTo(33.333, 2)
  })

  it('uses the whole series for ALL', () => {
    expect(windowPerf(series, Number.POSITIVE_INFINITY)?.delta).toBe(100)
  })

  it('falls back to the last two points when the window is too sparse', () => {
    const perf = windowPerf([{ d: today - 400 * day, v: 10 }, { d: today - 380 * day, v: 20 }], 7)
    expect(perf?.delta).toBe(10)
  })

  it('returns null when there is not enough history to compare', () => {
    expect(windowPerf([], 30)).toBeNull()
    expect(windowPerf([{ d: today, v: 1 }], 30)).toBeNull()
  })

  it('reports the low and high of the window', () => {
    // The window boundary is inclusive, so the point exactly 90 days old still counts.
    const perf = windowPerf(series, 90)
    expect(perf?.low).toBe(100)
    expect(perf?.high).toBe(200)
  })

  it('excludes points older than the window', () => {
    const perf = windowPerf(series, 60)
    expect(perf?.low).toBe(150)
    expect(perf?.points).toHaveLength(3)
  })
})
