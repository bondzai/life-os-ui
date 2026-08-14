/**
 * Tests for the three wealth detectors.
 *
 * Each covers fires / does not fire / boundary, plus the case that matters most here: what happens
 * when a figure is missing. A detector that treats an unreadable number as zero would put a
 * confident false statement about the user's money at the top of their morning brief, so "stays
 * silent when the data is absent" is asserted as deliberately as the firing cases.
 */

import { describe, expect, it } from 'vitest'
import type { WealthBrief, BriefLp } from '@/core/ai/context/wealth-context'
import { emptyWealthBrief } from '@/core/ai/context/wealth-context'
import type { DetectorContext } from './types'
import { detectNetWorthMove, MOVE_PCT_CRITICAL, MOVE_PCT_THRESHOLD } from './detect-networth-move'
import { detectTierDrift, DRIFT_PP_CRITICAL, DRIFT_PP_THRESHOLD } from './detect-tier-drift'
import { detectLpOutOfRange, LP_MIN_VALUE_USD } from './detect-lp-out-of-range'

function brief(overrides: Partial<WealthBrief> = {}): WealthBrief {
  return {
    netWorthUsd: 100_000,
    change24hPct: 0,
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

function ctx(wealth?: WealthBrief): DetectorContext {
  return { entities: [], trackers: [], today: '2026-08-15', now: Date.parse('2026-08-15T08:00:00Z'), wealth }
}

function lp(overrides: Partial<BriefLp> = {}): BriefLp {
  return {
    key: 'eth:uniswap:1',
    pair: 'ETH/USDC',
    protocol: 'Uniswap v3',
    chain: 'ethereum',
    valueUsd: 10_000,
    inRange: true,
    aprPct: 18.4,
    claimableUsd: 200,
    edge: null,
    inRangePct: 93,
    ...overrides,
  }
}

describe('detectNetWorthMove', () => {
  it('fires on a large drop, as a warning', () => {
    const [insight] = detectNetWorthMove(ctx(brief({ change24hPct: -7.2 })))
    expect(insight.type).toBe('warning')
    expect(insight.category).toBe('wealth')
    expect(insight.severity).toBe(2)
    expect(insight.title).toContain('down 7.2%')
    expect(insight.data.direction).toBe('down')
  })

  it('fires on a large rise, as info rather than a warning', () => {
    const [insight] = detectNetWorthMove(ctx(brief({ change24hPct: 8 })))
    expect(insight.type).toBe('info')
    expect(insight.title).toContain('up 8.0%')
  })

  it('escalates to critical severity past the critical threshold', () => {
    const [quiet] = detectNetWorthMove(ctx(brief({ change24hPct: -(MOVE_PCT_CRITICAL - 0.1) })))
    expect(quiet.severity).toBe(2)
    const [loud] = detectNetWorthMove(ctx(brief({ change24hPct: -MOVE_PCT_CRITICAL })))
    expect(loud.severity).toBe(3)
  })

  it('does not fire on an ordinary day', () => {
    expect(detectNetWorthMove(ctx(brief({ change24hPct: 1.2 })))).toHaveLength(0)
    expect(detectNetWorthMove(ctx(brief({ change24hPct: -3 })))).toHaveLength(0)
  })

  it('treats the threshold itself as firing and one step below as quiet', () => {
    expect(detectNetWorthMove(ctx(brief({ change24hPct: MOVE_PCT_THRESHOLD })))).toHaveLength(1)
    expect(detectNetWorthMove(ctx(brief({ change24hPct: MOVE_PCT_THRESHOLD - 0.01 })))).toHaveLength(0)
    // Symmetric on the downside.
    expect(detectNetWorthMove(ctx(brief({ change24hPct: -MOVE_PCT_THRESHOLD })))).toHaveLength(1)
  })

  it('stays silent when the change is unavailable rather than calling it flat', () => {
    // The whole point: null is "we could not read it", and a brief line saying the day was flat
    // would be a false statement about real money.
    expect(detectNetWorthMove(ctx(brief({ change24hPct: null })))).toHaveLength(0)
  })

  it('stays silent when net worth is unavailable, since the delta would be unanchored', () => {
    expect(detectNetWorthMove(ctx(brief({ change24hPct: -9, netWorthUsd: null })))).toHaveLength(0)
  })

  it('stays silent on a stale snapshot, whose 24h window already ended', () => {
    expect(detectNetWorthMove(ctx(brief({ change24hPct: -9, isStale: true })))).toHaveLength(0)
  })

  it('stays silent with no wealth data at all', () => {
    expect(detectNetWorthMove(ctx())).toHaveLength(0)
    expect(detectNetWorthMove(ctx(emptyWealthBrief('nothing loaded')))).toHaveLength(0)
  })
})

describe('detectTierDrift', () => {
  const targets = { store: 50, business: 30, trading: 20 }

  it('fires on the worst-drifting tier when a target exists', () => {
    // trading is 40% of net against a 20% target — 20pp over.
    const [insight] = detectTierDrift(
      ctx(
        brief({
          netWorthUsd: 100_000,
          tierUsd: { store: 40_000, business: 20_000, trading: 40_000 },
          targetTierPct: targets,
        }),
      ),
    )
    expect(insight.data.tier).toBe('trading')
    expect(insight.data.direction).toBe('over')
    expect(insight.title).toContain('over target by 20pp')
    expect(insight.severity).toBe(3)
  })

  it('reports only one line, since the tiers are shares of one whole', () => {
    const insights = detectTierDrift(
      ctx(
        brief({
          netWorthUsd: 100_000,
          tierUsd: { store: 10_000, business: 10_000, trading: 80_000 },
          targetTierPct: targets,
        }),
      ),
    )
    expect(insights).toHaveLength(1)
  })

  it('does not fire on drift within tolerance', () => {
    const insights = detectTierDrift(
      ctx(
        brief({
          netWorthUsd: 100_000,
          tierUsd: { store: 52_000, business: 29_000, trading: 19_000 },
          targetTierPct: targets,
        }),
      ),
    )
    expect(insights).toHaveLength(0)
  })

  it('treats the threshold itself as firing and one step below as quiet', () => {
    expect(DRIFT_PP_THRESHOLD).toBe(10)

    // trading at 30% against a 20% target is exactly DRIFT_PP_THRESHOLD.
    const atThreshold = brief({
      netWorthUsd: 100_000,
      tierUsd: { store: 40_000, business: 30_000, trading: 30_000 },
      targetTierPct: targets,
    })
    expect(detectTierDrift(ctx(atThreshold))).toHaveLength(1)

    // trading at 29% is 9pp — just inside tolerance.
    const belowThreshold = brief({
      netWorthUsd: 100_000,
      tierUsd: { store: 41_000, business: 30_000, trading: 29_000 },
      targetTierPct: targets,
    })
    expect(detectTierDrift(ctx(belowThreshold))).toHaveLength(0)
  })

  it('escalates past the critical threshold', () => {
    expect(DRIFT_PP_CRITICAL).toBe(20)
    const [insight] = detectTierDrift(
      ctx(
        brief({
          netWorthUsd: 100_000,
          tierUsd: { store: 35_000, business: 30_000, trading: 35_000 },
          targetTierPct: targets,
        }),
      ),
    )
    expect(insight.severity).toBe(2) // 15pp over — loud, not critical
  })

  it('stays silent without a configured target rather than inventing one', () => {
    // A "correct" allocation the user never chose is the single most dangerous thing this
    // detector could assert, so no target means no signal.
    const insights = detectTierDrift(
      ctx(brief({ tierUsd: { store: 100_000, business: 0, trading: 0 }, targetTierPct: null })),
    )
    expect(insights).toHaveLength(0)
  })

  it('stays silent when net worth is unavailable, since shares cannot be computed', () => {
    const insights = detectTierDrift(
      ctx(brief({ netWorthUsd: null, targetTierPct: targets })),
    )
    expect(insights).toHaveLength(0)
  })

  it('skips a tier whose total could not be read', () => {
    const insights = detectTierDrift(
      ctx(
        brief({
          netWorthUsd: 100_000,
          tierUsd: { store: null, business: 30_000, trading: 20_000 },
          targetTierPct: targets,
        }),
      ),
    )
    // store is unreadable and excluded; business and trading are both on target.
    expect(insights).toHaveLength(0)
  })

  it('stays silent with no wealth data at all', () => {
    expect(detectTierDrift(ctx())).toHaveLength(0)
  })
})

describe('detectLpOutOfRange', () => {
  it('fires for an out-of-range position, one insight each', () => {
    const insights = detectLpOutOfRange(
      ctx(
        brief({
          lps: [
            lp({ key: 'a', inRange: false, edge: '4.2% below min' }),
            lp({ key: 'b', pair: 'AERO/USDC', inRange: false }),
          ],
        }),
      ),
    )
    expect(insights).toHaveLength(2)
    expect(insights[0].type).toBe('warning')
    expect(insights[0].category).toBe('wealth')
    expect(insights[0].title).toContain('out of range')
    expect(insights[0].detail).toContain('4.2% below min')
    expect(insights[0].detail).toContain('earning nothing')
  })

  it('does not fire for a healthy in-range position', () => {
    expect(detectLpOutOfRange(ctx(brief({ lps: [lp({ inRange: true })] })))).toHaveLength(0)
  })

  it('ignores an out-of-range position too small to be worth waking up to', () => {
    const insights = detectLpOutOfRange(
      ctx(brief({ lps: [lp({ inRange: false, valueUsd: LP_MIN_VALUE_USD - 1 })] })),
    )
    expect(insights).toHaveLength(0)
  })

  it('fires exactly at the value threshold', () => {
    const insights = detectLpOutOfRange(
      ctx(brief({ lps: [lp({ inRange: false, valueUsd: LP_MIN_VALUE_USD })] })),
    )
    expect(insights).toHaveLength(1)
  })

  it('stays silent when range status is unknown rather than assuming either way', () => {
    // `null` covers full-range positions that legitimately have no range, so calling this
    // "out of range" would be wrong — but so would calling it healthy.
    expect(detectLpOutOfRange(ctx(brief({ lps: [lp({ inRange: null })] })))).toHaveLength(0)
  })

  it('omits the claimable clause when there is nothing to claim', () => {
    const [insight] = detectLpOutOfRange(
      ctx(brief({ lps: [lp({ inRange: false, claimableUsd: 0, edge: null })] })),
    )
    expect(insight.detail).not.toContain('claimable')
  })

  it('stays silent with no wealth data or no positions', () => {
    expect(detectLpOutOfRange(ctx())).toHaveLength(0)
    expect(detectLpOutOfRange(ctx(brief({ lps: [] })))).toHaveLength(0)
  })
})
