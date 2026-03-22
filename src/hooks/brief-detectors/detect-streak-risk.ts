import type { Detector, Insight } from './types'

export const detectStreakRisk: Detector = ({ entities, trackers, today }) => {
  const insights: Insight[] = []
  const todayStart = today + 'T00:00:00'

  const activeHabits = entities.filter(
    (e) => e.type === 'habit' && e.status === 'todo',
  )

  for (const habit of activeHabits) {
    const streak = typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
    if (streak < 3) continue // only warn for meaningful streaks

    const checkedToday = trackers.some(
      (t) => t.entityId === habit.id && t.timestamp >= todayStart,
    )

    if (!checkedToday) {
      insights.push({
        id: `streak-risk-${habit.id}`,
        type: 'streak',
        category: 'habits',
        severity: streak >= 30 ? 3 : streak >= 7 ? 2 : 1,
        title: `"${habit.title}" — ${streak}d streak${streak >= 28 ? ' ⚡' : ''}, not checked today`,
        actionLabel: 'Check in',
        actionPath: '/habits',
        data: { habitId: habit.id, streak, title: habit.title },
      })
    }
  }

  return insights
}
