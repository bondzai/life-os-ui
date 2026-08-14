/**
 * Tests for the wealth context builder.
 *
 * The contract being pinned: a figure that could not be read appears in the prompt as an explicit
 * UNAVAILABLE *and* as a data gap. Both halves matter — the token stops the model reading absence
 * as zero, and the gap list gives it something to tell the user about.
 */

import { describe, expect, it } from 'vitest'
import type { PortfolioData, NwPoint, DefiPosition, SpotToken } from '@/pages/wealth/types'
import type { Ctx } from '@/pages/wealth/derive'
import { UNAVAILABLE } from './wealth-envelope'
import {
  buildWealthContext,
  emptyWealthBrief,
  tierDrift,
  toWealthBrief,
  type WealthBrief,
} from './wealth-context'

function ctxOf(spot: SpotToken[] = [], defi: DefiPosition[] = []): Ctx {
  const data: PortfolioData = {
    total: 0,
    fetched_at: 0,
    rates: { thb: 32, btc_usd: 100_000 },
    wallets: [
      {
        address: '0xabc0000000000000000000000000000000000001',
        total: 0,
        chains: [{ chain: 'ethereum', usd: 0, spot, defi }],
      },
    ],
  }
  return { data, manual: [], dustUsd: 0 }
}

function brief(overrides: Partial<WealthBrief> = {}): WealthBrief {
  return {
    netWorthUsd: 100_000,
    change24hPct: 1.5,
    debtUsd: 0,
    ageSeconds: 60,
    isStale: false,
    tierUsd: { store: 50_000, business: 30_000, trading: 20_000 },
    targetTierPct: null,
    topHoldings: [],
    lps: [],
    lending: [],
    windows: [],
    claimableUsd: 0,
    dataGaps: [],
    ...overrides,
  }
}

describe('toWealthBrief', () => {
  it('returns an explaining empty brief when no snapshot is loaded', () => {
    const result = toWealthBrief({ ctx: null })
    expect(result.netWorthUsd).toBeNull()
    expect(result.dataGaps.join(' ')).toContain('No portfolio snapshot')
  })

  it('records a gap when no holding reports a 24h move', () => {
    const result = toWealthBrief({
      ctx: ctxOf([{ symbol: 'ETH', amount: 1, usd: 3000, change24h: null }]),
    })
    expect(result.change24hPct).toBeNull()
    expect(result.dataGaps.join(' ')).toContain('24h change is unavailable')
  })

  it('flags partial 24h coverage rather than presenting it as whole-book', () => {
    const result = toWealthBrief({
      ctx: ctxOf([
        { symbol: 'ETH', amount: 1, usd: 3000, change24h: 2 },
        { symbol: 'XYZ', amount: 1, usd: 1000, change24h: null },
      ]),
    })
    expect(result.change24hPct).not.toBeNull()
    expect(result.dataGaps.join(' ')).toContain('1 position(s) had no price move')
  })

  it('records a gap when no target allocation is configured', () => {
    const result = toWealthBrief({ ctx: ctxOf([{ symbol: 'ETH', amount: 1, usd: 3000 }]) })
    expect(result.targetTierPct).toBeNull()
    expect(result.dataGaps.join(' ')).toContain('do not invent a target')
  })

  it('records a gap when there is no history to trend', () => {
    const result = toWealthBrief({ ctx: ctxOf([{ symbol: 'ETH', amount: 1, usd: 3000 }]), history: [] })
    expect(result.dataGaps.join(' ')).toContain('not flat')
  })

  it('marks a stale snapshot so every figure inherits the caveat', () => {
    const result = toWealthBrief({
      ctx: ctxOf([{ symbol: 'ETH', amount: 1, usd: 3000, change24h: 1 }]),
      ageSeconds: 3600,
    })
    expect(result.isStale).toBe(true)
    expect(result.dataGaps.join(' ')).toContain('as of')
  })

  it('does not call a fresh snapshot stale', () => {
    const result = toWealthBrief({
      ctx: ctxOf([{ symbol: 'ETH', amount: 1, usd: 3000, change24h: 1 }]),
      ageSeconds: 30,
    })
    expect(result.isStale).toBe(false)
  })

  it('computes trend windows from history', () => {
    const day = 86_400_000
    const now = Date.now()
    const history: NwPoint[] = [
      { d: now - 6 * day, v: 100 },
      { d: now, v: 110 },
    ]
    const result = toWealthBrief({ ctx: ctxOf([{ symbol: 'ETH', amount: 1, usd: 110 }]), history, now })
    const week = result.windows.find((w) => w.label === '7D')
    expect(week?.changePct).toBeCloseTo(10, 1)
  })
})

describe('tierDrift', () => {
  it('computes drift only when both a share and a target exist', () => {
    const withTarget = tierDrift(
      brief({
        netWorthUsd: 100_000,
        tierUsd: { store: 60_000, business: 30_000, trading: 10_000 },
        targetTierPct: { store: 50, business: 30, trading: 20 },
      }),
    )
    expect(withTarget.find((d) => d.tier === 'store')?.driftPct).toBeCloseTo(10)
    expect(withTarget.find((d) => d.tier === 'trading')?.driftPct).toBeCloseTo(-10)

    const noTarget = tierDrift(brief({ targetTierPct: null }))
    expect(noTarget.every((d) => d.driftPct === null)).toBe(true)
  })

  it('yields null shares when net worth is unavailable, never a fabricated percentage', () => {
    const drift = tierDrift(brief({ netWorthUsd: null, targetTierPct: { store: 50, business: 30, trading: 20 } }))
    expect(drift.every((d) => d.actualPct === null && d.driftPct === null)).toBe(true)
  })
})

describe('buildWealthContext', () => {
  it('states loudly that there is nothing when given no brief at all', () => {
    const text = buildWealthContext(null)
    expect(text).toContain(UNAVAILABLE)
    expect(text).toContain('DATA RULES')
  })

  it('renders an unreadable figure as UNAVAILABLE and as a gap', () => {
    const text = buildWealthContext(brief({ netWorthUsd: null, change24hPct: null }))
    expect(text).toContain(`Net worth (USD): ${UNAVAILABLE}`)
    expect(text).toContain(`24h change: ${UNAVAILABLE}`)
    expect(text).toContain('DATA GAPS')
  })

  it('never lets a missing number render as zero', () => {
    const text = buildWealthContext(brief({ debtUsd: null, claimableUsd: null }))
    const debtLine = text.split('\n').find((l) => l.includes('Borrow debt'))
    expect(debtLine).toContain(UNAVAILABLE)
    expect(debtLine).not.toContain('$0.00')
  })

  it('distinguishes a real zero from an absent figure', () => {
    const text = buildWealthContext(brief({ debtUsd: 0 }))
    const debtLine = text.split('\n').find((l) => l.includes('Borrow debt'))
    expect(debtLine).toContain('$0.00')
    expect(debtLine).not.toContain(UNAVAILABLE)
  })

  it('marks every figure stale when the snapshot is stale', () => {
    const text = buildWealthContext(brief({ isStale: true, ageSeconds: 3600 }))
    expect(text).toContain('[STALE: 60m old]')
    // Not just the headline figure — a stale snapshot makes every number "as of".
    expect(text.match(/\[STALE:/g)?.length ?? 0).toBeGreaterThan(3)
  })

  it('says a target is missing rather than omitting the target lines', () => {
    const text = buildWealthContext(brief({ targetTierPct: null }))
    expect(text).toContain('store target')
    expect(text).toContain('no target configured')
  })

  it('says "none open" for empty position lists instead of dropping the section', () => {
    const text = buildWealthContext(brief({ lps: [], lending: [] }))
    expect(text).toContain('LP positions: none open.')
    expect(text).toContain('Borrow positions: none open.')
  })

  it('spells out an LP whose range or APR could not be read', () => {
    const text = buildWealthContext(
      brief({
        lps: [
          {
            key: 'a',
            pair: 'ETH/USDC',
            protocol: 'Uniswap v3',
            chain: 'ethereum',
            valueUsd: 1000,
            inRange: null,
            aprPct: null,
            claimableUsd: 0,
            edge: null,
            inRangePct: null,
          },
        ],
      }),
    )
    expect(text).toContain('range UNAVAILABLE')
    expect(text).toContain('APR UNAVAILABLE')
    expect(text).toContain('time-in-range UNAVAILABLE')
  })

  it('distinguishes a null health factor (no debt) from an unknown one', () => {
    const text = buildWealthContext(
      brief({
        lending: [
          { protocol: 'Aave v3', chain: 'ethereum', hf: null, ltvPct: 0, debtUsd: 0, collateralUsd: 1000 },
        ],
      }),
    )
    expect(text).toContain('not liquidatable')
    expect(text).not.toContain(`health factor ${UNAVAILABLE}`)
  })

  it('carries the brief\'s own data gaps into the rendered gaps list', () => {
    const text = buildWealthContext(brief({ dataGaps: ['the lending feed was unreachable'] }))
    expect(text).toContain('the lending feed was unreachable')
  })

  it('always ends with the rules that tell the model what UNAVAILABLE means', () => {
    const text = buildWealthContext(emptyWealthBrief('nothing loaded'))
    expect(text).toContain('does NOT mean zero')
    expect(text.indexOf('DATA GAPS')).toBeLessThan(text.indexOf('DATA RULES'))
  })
})
