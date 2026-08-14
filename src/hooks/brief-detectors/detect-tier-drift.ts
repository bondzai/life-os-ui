import type { Detector, Insight } from './types'
import { tierDrift } from '@/core/ai/context/wealth-context'

/** Percentage points away from target before drift is worth surfacing. */
export const DRIFT_PP_THRESHOLD = 10
/** Percentage points at which it becomes the loudest wealth signal. */
export const DRIFT_PP_CRITICAL = 20

/**
 * A tier that has drifted away from its configured target.
 *
 * Requires a configured target — with none, `tierDrift` yields `null` and this stays silent
 * rather than inventing a "correct" allocation to measure against. Only the worst-drifting tier
 * is reported, since the tiers are shares of one whole and one line describes the imbalance.
 */
export const detectTierDrift: Detector = ({ wealth }) => {
  const insights: Insight[] = []
  if (!wealth || !wealth.targetTierPct) return insights

  const drifts = tierDrift(wealth).filter(
    (d): d is typeof d & { driftPct: number; actualPct: number; targetPct: number } =>
      d.driftPct !== null && d.actualPct !== null && d.targetPct !== null,
  )
  if (drifts.length === 0) return insights

  const worst = drifts.reduce((a, b) => (Math.abs(b.driftPct) > Math.abs(a.driftPct) ? b : a))
  const magnitude = Math.abs(worst.driftPct)
  if (magnitude < DRIFT_PP_THRESHOLD) return insights

  const over = worst.driftPct > 0

  insights.push({
    id: `wealth-tier-drift-${worst.tier}`,
    type: 'suggestion',
    category: 'wealth',
    severity: magnitude >= DRIFT_PP_CRITICAL ? 3 : 2,
    title: `${worst.tier} tier ${over ? 'over' : 'under'} target by ${magnitude.toFixed(0)}pp`,
    detail: `${worst.actualPct.toFixed(0)}% actual vs ${worst.targetPct.toFixed(0)}% target`,
    actionLabel: 'Rebalance',
    actionPath: '/wealth',
    data: {
      tier: worst.tier,
      actualPct: worst.actualPct,
      targetPct: worst.targetPct,
      driftPct: worst.driftPct,
      direction: over ? 'over' : 'under',
    },
  })

  return insights
}
