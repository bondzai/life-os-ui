/**
 * Wealth context for the AI layer.
 *
 * `WealthBrief` is the seam. The wealth pages own the fetching (`data-source.ts`) and the
 * accounting (`derive.ts`); this file turns an already-derived `Ctx` into a flat, serializable
 * summary, and then into prompt text. Tools and detectors depend only on `WealthBrief`, so none of
 * them needs a data layer of its own and none can disagree with what the wealth pages display.
 *
 * Every optional number here means exactly one thing: **`null` is "could not be read", never
 * zero.** `toWealthBrief` records a matching entry in `dataGaps` each time it produces a `null`,
 * and `buildWealthContext` renders both through `wealth-envelope.ts`, so a gap can never silently
 * disappear between derivation and prompt.
 */

import {
  claimableUsd,
  cyclePerf,
  holdings,
  lendingPositions,
  lpPositions,
  netWorth,
  portfolioChange,
  rangeInfo,
  tierTotals,
  windowPerf,
  type Ctx,
} from '@/pages/wealth/derive'
import type { NwPoint, Tier } from '@/pages/wealth/types'
import {
  EnvelopeBuilder,
  STALE_AFTER_SECONDS,
  formatAge,
  type Figure,
} from './wealth-envelope'

export const TIERS: Tier[] = ['store', 'business', 'trading']

export interface BriefHolding {
  label: string
  usd: number
  /** Share of net worth, or `null` when net worth itself could not be computed. */
  pctOfNet: number | null
  chain: string
  change24h: number | null
}

export interface BriefLp {
  key: string
  pair: string
  protocol: string
  chain: string
  valueUsd: number
  /** `null` when the position does not report a range (a full-range or non-CL position). */
  inRange: boolean | null
  aprPct: number | null
  claimableUsd: number
  /** How far spot sits outside the band, when out of range. */
  edge: string | null
  /** Share of this fee cycle spent earning, 0–100; `null` when the server has not sampled it. */
  inRangePct: number | null
}

export interface BriefLending {
  protocol: string
  chain: string
  /** Health factor; `null` means no debt (not liquidatable), which is different from unknown. */
  hf: number | null
  ltvPct: number
  debtUsd: number
  collateralUsd: number
}

export interface BriefWindow {
  label: string
  changePct: number | null
  deltaUsd: number | null
}

export interface WealthBrief {
  netWorthUsd: number | null
  change24hPct: number | null
  debtUsd: number | null
  ageSeconds: number | null
  isStale: boolean
  /** Actual USD per tier. A tier the user holds nothing in is `0`; unreadable is `null`. */
  tierUsd: Record<Tier, number | null>
  /** Target allocation in percent, when the user has configured one. */
  targetTierPct: Record<Tier, number> | null
  topHoldings: BriefHolding[]
  lps: BriefLp[]
  lending: BriefLending[]
  windows: BriefWindow[]
  claimableUsd: number | null
  /** Human-readable reasons a figure above is `null` or stale. Never silently dropped. */
  dataGaps: string[]
}

export interface WealthBriefInput {
  ctx: Ctx | null
  history?: NwPoint[] | null
  /** Seconds since the snapshot was taken, from `useWealth`. */
  ageSeconds?: number | null
  /** `useWealth`'s own staleness verdict; falls back to `ageSeconds` when not supplied. */
  isStale?: boolean
  targetTierPct?: Record<Tier, number> | null
  now?: number
  topHoldingCount?: number
}

/** An empty brief that states why it is empty, for when wealth data never loaded. */
export function emptyWealthBrief(reason: string): WealthBrief {
  return {
    netWorthUsd: null,
    change24hPct: null,
    debtUsd: null,
    ageSeconds: null,
    isStale: false,
    tierUsd: { store: null, business: null, trading: null },
    targetTierPct: null,
    topHoldings: [],
    lps: [],
    lending: [],
    windows: [],
    claimableUsd: null,
    dataGaps: [reason],
  }
}

/**
 * Flattens the wealth `Ctx` into the shape the AI layer consumes.
 *
 * The derivations are reused rather than reimplemented, so the model is reasoning about the same
 * numbers the user is looking at — a second implementation here would eventually disagree with the
 * screen, and the model would confidently report the wrong one.
 */
export function toWealthBrief(input: WealthBriefInput): WealthBrief {
  const { ctx, history, targetTierPct = null, now = Date.now(), topHoldingCount = 8 } = input
  if (!ctx) {
    return emptyWealthBrief('No portfolio snapshot is loaded — every wealth figure is unavailable.')
  }

  const gaps: string[] = []
  const ageSeconds = input.ageSeconds ?? null
  const isStale =
    input.isStale ?? (ageSeconds !== null ? ageSeconds > STALE_AFTER_SECONDS : false)

  const rows = holdings(ctx)
  const net = netWorth(ctx, rows)
  const netWorthUsd = Number.isFinite(net) ? net : null
  if (netWorthUsd === null) gaps.push('Net worth could not be computed from the current snapshot.')

  // `portfolioChange` returns null when no holding reports a 24h change — a real gap, because a
  // missing change reads to a model as "flat", which is a claim rather than an absence.
  const change24hPct = portfolioChange(rows)
  if (change24hPct === null) {
    gaps.push('24h change is unavailable — no holding in this snapshot reported a 24h price move.')
  }
  const unpriced = rows.filter((r) => r.change === null).length
  if (change24hPct !== null && unpriced > 0) {
    gaps.push(
      `24h change covers only the holdings that reported one — ${unpriced} position(s) had no price move and are excluded from it.`,
    )
  }

  const totals = tierTotals(rows)
  const tierUsd = Object.fromEntries(
    TIERS.map((t) => [t, Number.isFinite(totals[t]) ? totals[t] : null]),
  ) as Record<Tier, number | null>
  for (const tier of TIERS) {
    if (tierUsd[tier] === null) gaps.push(`The ${tier} tier total could not be computed.`)
  }
  if (!targetTierPct) {
    gaps.push(
      'No target tier allocation is configured, so drift cannot be measured — do not invent a target.',
    )
  }

  const lendRows = lendingPositions(ctx.data)
  const debtUsd = lendRows.reduce((sum, r) => sum + r.debt_usd, 0)

  const lpRows = lpPositions(ctx.data)
  const lps: BriefLp[] = lpRows.map((row) => {
    const range = rangeInfo(row)
    const perf = cyclePerf(row, now)
    return {
      key: row.key,
      pair: row.pair,
      protocol: row.protocol,
      chain: row.chain,
      valueUsd: row.value,
      inRange: row.in_range,
      aprPct: row.apr,
      claimableUsd: row.fees,
      edge: range?.out ? range.edge : null,
      inRangePct: perf?.pct ?? null,
    }
  })
  for (const lp of lps) {
    if (lp.inRange === null) {
      gaps.push(`${lp.protocol} ${lp.pair}: range status unknown — do not assume it is earning.`)
    }
    if (lp.aprPct === null) {
      gaps.push(`${lp.protocol} ${lp.pair}: APR unavailable — do not estimate its yield.`)
    }
  }

  const lending: BriefLending[] = lendRows.map((row) => ({
    protocol: row.protocol,
    chain: row.chain,
    hf: row.hf,
    ltvPct: row.ltv * 100,
    debtUsd: row.debt_usd,
    collateralUsd: row.collateral_usd,
  }))

  const series = history ?? []
  const windows: BriefWindow[] = [
    { label: '7D', days: 7 },
    { label: '30D', days: 30 },
    { label: '90D', days: 90 },
  ].map(({ label, days }) => {
    const perf = windowPerf(series, days, now)
    return { label, changePct: perf?.pct ?? null, deltaUsd: perf?.delta ?? null }
  })
  if (series.length === 0) {
    gaps.push('No net-worth history is loaded — trend over time is unavailable, not flat.')
  } else if (series.length < 2) {
    gaps.push('Only one history point exists — no trend can be computed from it.')
  }

  const sorted = [...rows].sort((a, b) => b.usd - a.usd)
  const topHoldings: BriefHolding[] = sorted.slice(0, topHoldingCount).map((r) => ({
    label: r.label,
    usd: r.usd,
    pctOfNet: netWorthUsd && netWorthUsd !== 0 ? (r.usd / netWorthUsd) * 100 : null,
    chain: r.chain,
    change24h: r.change,
  }))

  if (isStale) {
    gaps.push(
      `The whole snapshot is ${formatAge(ageSeconds)} — every figure is "as of" that moment, not now.`,
    )
  }

  return {
    netWorthUsd,
    change24hPct,
    debtUsd,
    ageSeconds,
    isStale,
    tierUsd,
    targetTierPct,
    topHoldings,
    lps,
    lending,
    windows,
    claimableUsd: claimableUsd(lpRows),
    dataGaps: gaps,
  }
}

/** Percentage-point drift of each tier against its target. `null` where either side is unknown. */
export function tierDrift(
  brief: WealthBrief,
): { tier: Tier; actualPct: number | null; targetPct: number | null; driftPct: number | null }[] {
  const net = brief.netWorthUsd
  return TIERS.map((tier) => {
    const usd = brief.tierUsd[tier]
    const actualPct = usd !== null && net !== null && net !== 0 ? (usd / net) * 100 : null
    const targetPct = brief.targetTierPct?.[tier] ?? null
    return {
      tier,
      actualPct,
      targetPct,
      driftPct: actualPct !== null && targetPct !== null ? actualPct - targetPct : null,
    }
  })
}

/** A figure carrying the whole brief's staleness, so one stale snapshot marks every number. */
function figure(brief: WealthBrief, label: string, value: Figure['value'], unit: Figure['unit'], note?: string): Figure {
  const stale = brief.isStale && value !== null && value !== undefined
  return {
    label,
    value,
    unit,
    state: stale ? 'stale' : undefined,
    note: stale ? formatAge(brief.ageSeconds) : note,
  }
}

/**
 * The shared wealth context block every wealth tool starts from.
 *
 * Sections are always present even when their contents are empty, and an empty section says so
 * out loud — "no LP positions" is a fact, whereas a missing LP section is an ambiguity the model
 * would resolve by guessing.
 */
export function buildWealthContext(brief: WealthBrief | null): string {
  if (!brief) {
    return new EnvelopeBuilder()
      .gap('No wealth data was supplied to this prompt at all.')
      .text('Portfolio: UNAVAILABLE — the wealth data source returned nothing.')
      .render()
  }

  const builder = new EnvelopeBuilder()

  builder.section('Portfolio', [
    figure(brief, 'Net worth (USD)', brief.netWorthUsd, 'usd'),
    figure(brief, '24h change', brief.change24hPct, 'pct'),
    figure(brief, 'Borrow debt (USD)', brief.debtUsd, 'usd'),
    figure(brief, 'Claimable LP rewards (USD)', brief.claimableUsd, 'usd'),
    {
      label: 'Snapshot age',
      value: brief.ageSeconds === null ? null : formatAge(brief.ageSeconds),
      unit: 'text',
      note: brief.ageSeconds === null ? 'the snapshot carried no timestamp' : undefined,
    },
  ])

  const drift = tierDrift(brief)
  builder.section(
    'Tier allocation',
    drift.flatMap((d) => [
      figure(brief, `  ${d.tier} (USD)`, brief.tierUsd[d.tier], 'usd'),
      {
        label: `  ${d.tier} share`,
        value: d.actualPct,
        unit: 'pct' as const,
        note: d.actualPct === null ? 'net worth unavailable, so a share cannot be computed' : undefined,
      },
      {
        label: `  ${d.tier} target`,
        value: d.targetPct,
        unit: 'pct' as const,
        note: d.targetPct === null ? 'no target configured for this tier' : undefined,
      },
      {
        label: `  ${d.tier} drift vs target`,
        value: d.driftPct,
        unit: 'pct' as const,
        note: d.driftPct === null ? 'needs both a share and a target' : undefined,
      },
    ]),
  )

  builder.section(
    'Net-worth trend',
    brief.windows.map((w) => ({
      label: `  ${w.label}`,
      value: w.changePct,
      unit: 'pct' as const,
      note: w.changePct === null ? 'not enough history in this window' : undefined,
    })),
  )

  if (brief.topHoldings.length === 0) {
    builder.text('Top holdings: none — the snapshot contains no priced positions.')
  } else {
    builder.text(
      [
        'Top holdings (largest first):',
        ...brief.topHoldings.map((h) => {
          const share = h.pctOfNet === null ? 'share UNAVAILABLE' : `${h.pctOfNet.toFixed(1)}% of net`
          const change = h.change24h === null ? '24h UNAVAILABLE' : `${h.change24h >= 0 ? '+' : ''}${h.change24h.toFixed(1)}% 24h`
          return `  - ${h.label} [${h.chain}]: $${h.usd.toFixed(2)}, ${share}, ${change}`
        }),
      ].join('\n'),
    )
  }

  if (brief.lps.length === 0) {
    builder.text('LP positions: none open.')
  } else {
    builder.text(
      [
        'LP positions:',
        ...brief.lps.map((lp) => {
          const range =
            lp.inRange === null
              ? 'range UNAVAILABLE'
              : lp.inRange
                ? 'in range'
                : `OUT OF RANGE${lp.edge ? ` (${lp.edge})` : ''}`
          const apr = lp.aprPct === null ? 'APR UNAVAILABLE' : `${lp.aprPct.toFixed(1)}% APR`
          const earning =
            lp.inRangePct === null
              ? 'time-in-range UNAVAILABLE'
              : `${lp.inRangePct.toFixed(0)}% of cycle earning`
          return `  - ${lp.protocol} ${lp.pair} [${lp.chain}]: $${lp.valueUsd.toFixed(2)}, ${range}, ${apr}, ${earning}, $${lp.claimableUsd.toFixed(2)} claimable`
        }),
      ].join('\n'),
    )
  }

  if (brief.lending.length === 0) {
    builder.text('Borrow positions: none open.')
  } else {
    builder.text(
      [
        'Borrow positions:',
        ...brief.lending.map((l) => {
          const hf =
            l.hf === null
              ? 'health factor N/A (no debt — not liquidatable)'
              : `health factor ${l.hf.toFixed(2)}`
          return `  - ${l.protocol} [${l.chain}]: ${hf}, LTV ${l.ltvPct.toFixed(1)}%, $${l.debtUsd.toFixed(2)} debt against $${l.collateralUsd.toFixed(2)} collateral`
        }),
      ].join('\n'),
    )
  }

  for (const gap of brief.dataGaps) builder.gap(gap)

  return builder.render()
}
