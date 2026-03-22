import type { Detector, Insight } from './types'

const MS_PER_DAY = 86_400_000

export const detectSleepDrop: Detector = ({ entities, now }) => {
  const insights: Insight[] = []
  const sleepEntries = entities
    .filter((e) => e.type === 'sleep-mood' && typeof e.metadata.sleepHours === 'number')
    .sort((a, b) => ((b.metadata.date as string) || '').localeCompare((a.metadata.date as string) || ''))

  if (sleepEntries.length < 5) return insights

  // Last 7 days average vs previous 7 days
  const recentCutoff = new Date(now - 7 * MS_PER_DAY).toISOString().split('T')[0]
  const olderCutoff = new Date(now - 14 * MS_PER_DAY).toISOString().split('T')[0]

  const recent = sleepEntries.filter((e) => ((e.metadata.date as string) || '') >= recentCutoff)
  const older = sleepEntries.filter(
    (e) => {
      const d = (e.metadata.date as string) || ''
      return d >= olderCutoff && d < recentCutoff
    },
  )

  if (recent.length === 0 || older.length === 0) return insights

  const avgRecent = recent.reduce((s, e) => s + (e.metadata.sleepHours as number), 0) / recent.length
  const avgOlder = older.reduce((s, e) => s + (e.metadata.sleepHours as number), 0) / older.length
  const drop = avgOlder - avgRecent

  if (drop >= 1) {
    insights.push({
      id: 'sleep-drop',
      type: 'warning',
      category: 'health',
      severity: drop >= 2 ? 3 : 2,
      title: `Sleep avg ${avgRecent.toFixed(1)}h this week (down from ${avgOlder.toFixed(1)}h)`,
      actionLabel: 'View',
      actionPath: '/health',
      data: { avgRecent: +avgRecent.toFixed(1), avgOlder: +avgOlder.toFixed(1), drop: +drop.toFixed(1) },
    })
  }

  return insights
}
