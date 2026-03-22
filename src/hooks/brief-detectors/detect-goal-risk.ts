import type { Detector, Insight } from './types'

const MS_PER_DAY = 86_400_000
const MS_PER_WEEK = 7 * MS_PER_DAY

export const detectGoalRisk: Detector = ({ entities, now }) => {
  const insights: Insight[] = []

  const goals = entities.filter(
    (e) => e.type === 'goal' && e.status !== 'done' && e.status !== 'archived' && e.dueDate,
  )

  for (const goal of goals) {
    const tasks = entities.filter(
      (e) => e.type === 'task' && e.status !== 'archived' && e.metadata?.goalId === goal.id,
    )
    if (tasks.length === 0) continue

    const remaining = tasks.filter((t) => t.status !== 'done').length
    if (remaining === 0) continue

    // Weekly velocity: tasks completed in last 4 weeks
    const fourWeeksAgo = new Date(now - 4 * MS_PER_WEEK).toISOString()
    const recentDone = tasks.filter(
      (t) => t.status === 'done' && (t.updatedAt ?? t.createdAt) >= fourWeeksAgo,
    ).length
    const avgPerWeek = recentDone / 4

    if (avgPerWeek === 0) {
      const dueMs = new Date(goal.dueDate!).getTime()
      if (dueMs < now) continue // already overdue, handled by detectOverdue
      insights.push({
        id: `goal-risk-${goal.id}`,
        type: 'risk',
        category: 'goals',
        severity: 3,
        title: `"${goal.title}" — ${remaining} tasks left, zero velocity`,
        actionLabel: 'View',
        actionPath: `/goals?id=${goal.id}`,
        data: { goalId: goal.id, remaining, velocity: 0, title: goal.title },
      })
      continue
    }

    const weeksNeeded = remaining / avgPerWeek
    const projectedMs = now + weeksNeeded * MS_PER_WEEK
    const dueMs = new Date(goal.dueDate!).getTime()

    if (projectedMs > dueMs) {
      const daysOver = Math.ceil((projectedMs - dueMs) / MS_PER_DAY)
      insights.push({
        id: `goal-risk-${goal.id}`,
        type: 'risk',
        category: 'goals',
        severity: daysOver > 14 ? 3 : 2,
        title: `"${goal.title}" will miss deadline by ~${daysOver}d at current pace`,
        actionLabel: 'View',
        actionPath: `/goals?id=${goal.id}`,
        data: { goalId: goal.id, remaining, avgPerWeek, daysOver, title: goal.title },
      })
    }
  }

  return insights
}
