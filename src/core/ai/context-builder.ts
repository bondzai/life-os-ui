import { EntityRepository } from '@/core/repositories/entity-repository'
import { getSolPrefix } from './soul'
import type { Entity } from '@/core/types'

export interface EntityContext {
  tasks: Entity[]
  goals: Entity[]
  habits: Entity[]
  events: Entity[]
  projects: Entity[]
  other: Entity[]
}

const entityRepository = new EntityRepository()

export async function gatherContext(): Promise<EntityContext> {
  const all = await entityRepository.getAll()

  const tasks = all.filter((e) => e.type === 'task' && e.status !== 'archived').slice(0, 20)
  const goals = all.filter((e) => e.type === 'goal' && e.status !== 'archived').slice(0, 10)
  const habits = all.filter((e) => e.type === 'habit' && e.status === 'todo').slice(0, 10)
  const events = all.filter((e) => e.type === 'event' && e.status !== 'archived').slice(0, 10)
  const projects = all.filter((e) => e.type === 'project' && e.status !== 'archived').slice(0, 10)
  const other = all
    .filter(
      (e) =>
        !['task', 'goal', 'habit', 'event', 'project'].includes(e.type) && e.status !== 'archived',
    )
    .slice(0, 10)

  return { tasks, goals, habits, events, projects, other }
}

function formatEntity(e: Entity): string {
  const parts = [`- ${e.title} [${e.status}/${e.priority}]`]
  if (e.dueDate) parts.push(`due:${e.dueDate}`)
  if (e.description) parts.push(`"${e.description}"`)
  return parts.join(' ')
}

function formatProject(e: Entity): string {
  const parts = [`- ${e.title} [${e.status}]`]
  const category = e.metadata?.category as string | undefined
  const domain = e.metadata?.domain as string | undefined
  const stack = e.metadata?.stack as string[] | undefined
  const summary = e.metadata?.summary as string | undefined
  if (category) parts.push(`(${category})`)
  if (domain) parts.push(`[${domain}]`)
  if (stack?.length) parts.push(`stack: ${stack.join(', ')}`)
  if (summary) parts.push(`— ${summary}`)
  return parts.join(' ')
}

function formatSection(label: string, entities: Entity[]): string {
  if (entities.length === 0) return ''
  return `## ${label}\n${entities.map(formatEntity).join('\n')}`
}

export function buildSystemPrompt(context: EntityContext): string {
  const today = new Date().toISOString().split('T')[0]
  const projectSection = context.projects.length > 0
    ? `## Active Projects\n${context.projects.map(formatProject).join('\n')}`
    : ''

  const sections = [
    getSolPrefix(200),
    `Today is ${today}. Here is the user's current data:`,
    projectSection,
    formatSection('Tasks', context.tasks),
    formatSection('Goals', context.goals),
    formatSection('Habits', context.habits),
    formatSection('Events', context.events),
    formatSection('Other Items', context.other),
    'This context is available for reference. Only use it when relevant to the user\'s question. Do NOT summarize this data unless asked.',
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

/* ─── Insight-aware prompts (for Morning Brief AI summary) ─── */

export interface BriefInsight {
  type: string
  category: string
  severity: number
  title: string
  data: Record<string, unknown>
}

export function buildBriefSummaryPrompt(insights: BriefInsight[]): string {
  const insightLines = insights.map((i) => `- [${i.type}/${i.category}] ${i.title}`).join('\n')

  return [
    getSolPrefix(60),
    '',
    'These signals were detected:',
    '',
    insightLines,
    '',
    'Write a 2-3 sentence summary. Flowing prose, no bullet points.',
    'Prioritize the most critical items. Mention specific names and numbers.',
  ].join('\n')
}
