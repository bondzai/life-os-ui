import type { Detector, Insight } from './types'
import { getSleepTrend } from './utils'

export const detectSleepDrop: Detector = ({ entities, now }) => {
  const insights: Insight[] = []

  const trend = getSleepTrend(entities, now)
  if (!trend) return insights

  if (trend.drop >= 1) {
    insights.push({
      id: 'sleep-drop',
      type: 'warning',
      category: 'health',
      severity: trend.drop >= 2 ? 3 : 2,
      title: `Sleep avg ${trend.recentAvg.toFixed(1)}h this week (down from ${trend.olderAvg.toFixed(1)}h)`,
      actionLabel: 'View',
      actionPath: '/health',
      data: {
        avgRecent: +trend.recentAvg.toFixed(1),
        avgOlder: +trend.olderAvg.toFixed(1),
        drop: +trend.drop.toFixed(1),
      },
    })
  }

  return insights
}
