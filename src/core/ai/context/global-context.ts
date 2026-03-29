import type { Entity } from '@/core/types'
import { isGoal, isTask } from '@/core/types'
import type { Tracker } from '@/core/types/tracker'

export function buildGlobalContext(entities: Entity[], trackers: Tracker[]): string {
  const today = new Date().toISOString().split('T')[0]
  const lines: string[] = [`Date: ${today}`]

  // Projects / Goals
  const projects = entities.filter((e) => isGoal(e) && e.status === 'in-progress')
  if (projects.length > 0) {
    lines.push(`\nActive Goals (${projects.length}):`)
    projects.forEach((p) => {
      const tasks = entities.filter((e) => isTask(e) && e.metadata?.projectId === p.id && e.status !== 'archived')
      const done = tasks.filter((t) => t.status === 'done').length
      lines.push(`  - ${p.title} [${done}/${tasks.length} tasks]`)
    })
  }

  // Goals
  const goals = entities.filter((e) => isGoal(e) && e.status !== 'done' && e.status !== 'archived')
  if (goals.length > 0) {
    lines.push(`\nActive Goals (${goals.length}):`)
    goals.slice(0, 10).forEach((g) => {
      const progress = typeof g.metadata?.progress === 'number' ? g.metadata.progress : 0
      lines.push(`  - ${g.title} [${g.priority}] ${progress}%${g.dueDate ? ` due:${g.dueDate}` : ''}`)
    })
  }

  // Tasks summary
  const tasks = entities.filter((e) => isTask(e) && e.status !== 'archived')
  const overdue = tasks.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < today)
  const inProgress = tasks.filter((t) => t.status === 'in-progress')
  lines.push(`\nTasks: ${tasks.length} total, ${inProgress.length} in-progress, ${overdue.length} overdue`)

  // Habits
  const habits = entities.filter((e) => e.type === 'habit' && e.status === 'todo')
  const todayStart = today + 'T00:00:00'
  const checkedToday = habits.filter((h) => trackers.some((t) => t.entityId === h.id && t.timestamp >= todayStart)).length
  lines.push(`Habits: ${checkedToday}/${habits.length} checked today`)

  return lines.join('\n')
}
