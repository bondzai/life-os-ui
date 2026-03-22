import type { Entity } from '@/core/types'

export function buildProjectContext(project: Entity, entities: Entity[]): string {
  const lines: string[] = [`Project: "${project.title}" [${project.status}]`]

  if (project.description) lines.push(`Description: ${project.description}`)
  if (project.dueDate) lines.push(`Due: ${project.dueDate}`)

  const category = project.metadata?.category as string | undefined
  const domain = project.metadata?.domain as string | undefined
  const stack = project.metadata?.stack as string[] | undefined
  const summary = project.metadata?.summary as string | undefined

  if (category) lines.push(`Category: ${category}`)
  if (domain) lines.push(`Domain: ${domain}`)
  if (stack?.length) lines.push(`Stack: ${stack.join(', ')}`)
  if (summary) lines.push(`Summary: ${summary}`)

  // Tasks
  const tasks = entities.filter((e) => e.type === 'task' && e.status !== 'archived' && e.metadata?.projectId === project.id)
  const done = tasks.filter((t) => t.status === 'done').length
  const inProgress = tasks.filter((t) => t.status === 'in-progress').length
  lines.push(`Tasks: ${done} done, ${inProgress} in-progress, ${tasks.length - done - inProgress} remaining`)

  if (tasks.length > 0) {
    tasks.filter((t) => t.status !== 'done').slice(0, 10).forEach((t) =>
      lines.push(`  - [${t.status}/${t.priority}] ${t.title}${t.dueDate ? ` due:${t.dueDate}` : ''}`),
    )
  }

  return lines.join('\n')
}
