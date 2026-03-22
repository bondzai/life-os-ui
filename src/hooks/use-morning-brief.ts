import { useMemo } from 'react'
import { useEntities, useTrackers } from '@/core/hooks'
import {
  detectStreakRisk,
  detectStaleProjects,
  detectBudgetWarn,
  detectSleepDrop,
  detectEnergyPattern,
  detectDecisionReview,
  detectAchievements,
  detectVelocity,
  detectThreats,
  type Insight,
  type DetectorContext,
} from './brief-detectors'

// Only cross-domain signals — tasks/goals already visible in the Focus picker
const DETECTORS = [
  detectStreakRisk,      // habits
  detectStaleProjects,   // projects
  detectBudgetWarn,      // wealth
  detectSleepDrop,       // health
  detectEnergyPattern,   // energy
  detectDecisionReview,  // decisions
  detectAchievements,    // milestones
  detectVelocity,        // project velocity changes
  detectThreats,         // future threat predictions
]

export function useMorningBrief(): Insight[] {
  const { items: entities } = useEntities()
  const { items: trackers } = useTrackers()

  return useMemo(() => {
    const ctx: DetectorContext = {
      entities,
      trackers,
      today: new Date().toISOString().split('T')[0],
      now: Date.now(),
    }

    const insights: Insight[] = []
    for (const detect of DETECTORS) {
      insights.push(...detect(ctx))
    }

    // Sort: severity desc, then by type priority
    const typePriority: Record<string, number> = {
      warning: 0,
      risk: 1,
      streak: 2,
      suggestion: 3,
      achievement: 4,
      info: 5,
    }

    insights.sort((a, b) => {
      if (a.severity !== b.severity) return b.severity - a.severity
      return (typePriority[a.type] ?? 9) - (typePriority[b.type] ?? 9)
    })

    return insights
  }, [entities, trackers])
}
