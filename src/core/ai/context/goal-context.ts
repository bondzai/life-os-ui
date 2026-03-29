import type { Entity } from '@/core/types'
import { isGoal, isTask } from '@/core/types'

export function buildGoalContext(goal: Entity, entities: Entity[]): string {
  const lines: string[] = [`Goal: "${goal.title}" [${goal.status}/${goal.priority}]`]

  if (goal.description) lines.push(`Description: ${goal.description}`)
  if (goal.dueDate) lines.push(`Due: ${goal.dueDate}`)

  const progress = typeof goal.metadata?.progress === 'number' ? goal.metadata.progress : 0
  lines.push(`Progress: ${progress}%`)

  // Sub-goals
  const subGoals = entities.filter((e) => isGoal(e) && e.parentId === goal.id && e.status !== 'archived')
  if (subGoals.length > 0) {
    lines.push(`Sub-goals (${subGoals.length}):`)
    subGoals.forEach((sg) => {
      const p = typeof sg.metadata?.progress === 'number' ? sg.metadata.progress : 0
      lines.push(`  - ${sg.title} [${sg.status}] ${p}%`)
    })
  }

  // Linked tasks
  const tasks = entities.filter((e) => isTask(e) && e.status !== 'archived' && e.metadata?.goalId === goal.id)
  if (tasks.length > 0) {
    const done = tasks.filter((t) => t.status === 'done').length
    lines.push(`Linked tasks: ${done}/${tasks.length} done`)
    tasks.slice(0, 10).forEach((t) => lines.push(`  - [${t.status}] ${t.title}`))
  }

  return lines.join('\n')
}
