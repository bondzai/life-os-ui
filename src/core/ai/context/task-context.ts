import type { Entity } from '@/core/types'

export function buildTaskContext(task: Entity, entities: Entity[]): string {
  const lines: string[] = [`Task: "${task.title}" [${task.status}/${task.priority}]`]

  if (task.description) lines.push(`Description: ${task.description}`)
  if (task.dueDate) lines.push(`Due: ${task.dueDate}`)

  // Subtasks
  const subs = Array.isArray(task.metadata?.subtasks) ? (task.metadata.subtasks as Array<{ title: string; done: boolean; status?: string }>) : []
  if (subs.length > 0) {
    const done = subs.filter((s) => s.status === 'done' || s.done).length
    lines.push(`Subtasks: ${done}/${subs.length} done`)
    subs.forEach((s) => lines.push(`  - [${s.status ?? (s.done ? 'done' : 'todo')}] ${s.title}`))
  }

  // Project
  const projectId = task.metadata?.projectId as string | undefined
  if (projectId) {
    const project = entities.find((e) => e.id === projectId)
    if (project) lines.push(`Project: ${project.title}`)
  }

  // Goal
  const goalId = task.metadata?.goalId as string | undefined
  if (goalId) {
    const goal = entities.find((e) => e.id === goalId)
    if (goal) lines.push(`Goal: ${goal.title}`)
  }

  return lines.join('\n')
}
