import { EntityRepository } from '@/core/repositories/entity-repository'
import type { Entity } from '@/core/types'

export interface EntityContext {
  tasks: Entity[]
  goals: Entity[]
  habits: Entity[]
  events: Entity[]
  other: Entity[]
}

const entityRepository = new EntityRepository()

export async function gatherContext(): Promise<EntityContext> {
  const all = await entityRepository.getAll()

  const tasks = all.filter((e) => e.type === 'task' && e.status !== 'archived').slice(0, 20)
  const goals = all.filter((e) => e.type === 'goal' && e.status !== 'archived').slice(0, 10)
  const habits = all.filter((e) => e.type === 'habit' && e.status === 'active').slice(0, 10)
  const events = all.filter((e) => e.type === 'event' && e.status !== 'archived').slice(0, 10)
  const other = all
    .filter(
      (e) =>
        !['task', 'goal', 'habit', 'event'].includes(e.type) && e.status !== 'archived',
    )
    .slice(0, 10)

  return { tasks, goals, habits, events, other }
}

function formatEntity(e: Entity): string {
  const parts = [`- ${e.title} [${e.status}/${e.priority}]`]
  if (e.dueDate) parts.push(`due:${e.dueDate}`)
  if (e.description) parts.push(`"${e.description}"`)
  return parts.join(' ')
}

function formatSection(label: string, entities: Entity[]): string {
  if (entities.length === 0) return ''
  return `## ${label}\n${entities.map(formatEntity).join('\n')}`
}

export function buildSystemPrompt(context: EntityContext): string {
  const today = new Date().toISOString().split('T')[0]
  const sections = [
    `You are a helpful life management assistant. Today is ${today}.`,
    'Here is the user\'s current data:',
    formatSection('Tasks', context.tasks),
    formatSection('Goals', context.goals),
    formatSection('Habits', context.habits),
    formatSection('Events', context.events),
    formatSection('Other Items', context.other),
    'Use this context to provide relevant, actionable advice. Be concise.',
  ].filter(Boolean)

  return sections.join('\n\n')
}

export function buildDailyBriefPrompt(context: EntityContext): string {
  const base = buildSystemPrompt(context)
  return (
    base +
    '\n\nGenerate a short daily brief (3-5 bullet points). Include: ' +
    'tasks due today or overdue, upcoming deadlines, goal check-ins, ' +
    'and one motivational note. Keep it under 200 words.'
  )
}
