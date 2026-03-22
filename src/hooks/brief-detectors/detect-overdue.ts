import type { Detector, Insight } from './types'

const MS_PER_DAY = 86_400_000

export const detectOverdue: Detector = ({ entities, today }) => {
  const insights: Insight[] = []
  const overdue = entities.filter(
    (e) =>
      (e.type === 'task' || e.type === 'chore') &&
      e.status !== 'done' &&
      e.status !== 'archived' &&
      e.dueDate &&
      e.dueDate < today,
  )

  if (overdue.length === 0) return insights

  const oldestDays = Math.max(
    ...overdue.map((t) => Math.floor((Date.now() - new Date(t.dueDate!).getTime()) / MS_PER_DAY)),
  )

  insights.push({
    id: 'overdue-tasks',
    type: 'warning',
    category: 'tasks',
    severity: overdue.length >= 5 ? 3 : 2,
    title: `${overdue.length} task${overdue.length > 1 ? 's' : ''} overdue (oldest: ${oldestDays}d)`,
    actionLabel: 'View',
    actionPath: '/tasks',
    data: { count: overdue.length, oldestDays, ids: overdue.map((t) => t.id) },
  })

  return insights
}
