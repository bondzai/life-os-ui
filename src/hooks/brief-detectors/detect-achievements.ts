import type { Detector, Insight } from './types'

const MILESTONES = [7, 30, 90, 180, 365]

export const detectAchievements: Detector = ({ entities, trackers }) => {
  const insights: Insight[] = []
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayISO = todayStart.toISOString()

  // Habit streak milestones
  const habits = entities.filter((e) => e.type === 'habit' && e.status === 'todo')
  for (const habit of habits) {
    const streak = typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
    const checkedToday = trackers.some((t) => t.entityId === habit.id && t.timestamp >= todayISO)

    for (const milestone of MILESTONES) {
      // About to hit milestone (streak is milestone - 1 and checked today)
      if (streak === milestone - 1 && checkedToday) {
        insights.push({
          id: `milestone-${habit.id}-${milestone}`,
          type: 'achievement',
          category: 'habits',
          severity: 1,
          title: `"${habit.title}" hits ${milestone}-day streak!`,
          data: { habitId: habit.id, streak: milestone, title: habit.title },
        })
      }
      // At milestone exactly
      if (streak === milestone) {
        insights.push({
          id: `at-milestone-${habit.id}-${milestone}`,
          type: 'achievement',
          category: 'habits',
          severity: 1,
          title: `"${habit.title}" — ${milestone}-day streak active`,
          data: { habitId: habit.id, streak: milestone, title: habit.title },
        })
      }
    }
  }

  return insights
}
