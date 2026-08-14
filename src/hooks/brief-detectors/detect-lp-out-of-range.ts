import type { Detector, Insight } from './types'

/** An out-of-range position below this is not worth waking up to. */
export const LP_MIN_VALUE_USD = 500

/**
 * A liquidity position that has drifted out of its range.
 *
 * This is the wealth signal with the clearest cost: an out-of-range LP earns nothing while its
 * advertised APR keeps reading high, so it is easy to miss for days. One insight per position,
 * because each needs its own rebalance decision.
 *
 * Positions whose range status is unknown (`inRange === null`) are skipped rather than assumed
 * healthy — but they are not reported as broken either, since a full-range position legitimately
 * has no range. The AI prompts carry that distinction; the brief only claims what it knows.
 */
export const detectLpOutOfRange: Detector = ({ wealth }) => {
  const insights: Insight[] = []
  if (!wealth) return insights

  for (const lp of wealth.lps) {
    if (lp.inRange !== false) continue
    if (lp.valueUsd < LP_MIN_VALUE_USD) continue

    insights.push({
      id: `wealth-lp-out-of-range-${lp.key}`,
      type: 'warning',
      category: 'wealth',
      severity: 2,
      title: `${lp.protocol} ${lp.pair} is out of range`,
      detail: [
        `$${lp.valueUsd.toFixed(0)} earning nothing`,
        lp.edge,
        lp.claimableUsd > 0 ? `$${lp.claimableUsd.toFixed(0)} claimable` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      actionLabel: 'View',
      actionPath: '/wealth',
      data: {
        key: lp.key,
        protocol: lp.protocol,
        pair: lp.pair,
        chain: lp.chain,
        valueUsd: lp.valueUsd,
        claimableUsd: lp.claimableUsd,
        edge: lp.edge,
      },
    })
  }

  return insights
}
