import type { Entity } from '@/core/types'
import type { Tracker } from '@/core/types/tracker'

/** Build a formatted list of available task candidates for AI selection */
export function buildCandidateList(entities: Entity[], limit = 30): string {
  return entities
    .filter(
      (e) =>
        (e.type === 'task' || e.type === 'goal') &&
        (e.status === 'todo' || e.status === 'in-progress'),
    )
    .slice(0, limit)
    .map((e) => {
      const points = e.metadata?.points as number | undefined
      return `- [${e.id}] "${e.title}" [${e.type}/${e.priority}]${points ? ` est:${points}pts` : ''}${e.dueDate ? ` due:${e.dueDate}` : ''}`
    })
    .join('\n')
}

/** Compute morning/afternoon energy averages from trackers */
export function getEnergyAverages(trackers: Tracker[]): { morning: string; afternoon: string } {
  const energyTrackers = trackers.filter((t) => t.unit === 'energy')
  const morningEntries = energyTrackers.filter((t) => t.note === 'morning')
  const afternoonEntries = energyTrackers.filter((t) => t.note === 'afternoon')

  const morning =
    morningEntries.length > 0
      ? (morningEntries.reduce((s, t) => s + t.value, 0) / morningEntries.length).toFixed(1)
      : 'unknown'
  const afternoon =
    afternoonEntries.length > 0
      ? (afternoonEntries.reduce((s, t) => s + t.value, 0) / afternoonEntries.length).toFixed(1)
      : 'unknown'

  return { morning, afternoon }
}

/** Build knowledge signals section for strategic analysis */
export function buildKnowledgeSignals(entities: Entity[]): string {
  const notes = entities.filter(
    (e) => e.type === 'note' && !e.metadata?.isInbox && e.status !== 'archived',
  )
  const ideas = notes.filter((n) => n.tags.some((t) => ['idea', 'spark'].includes(t)))
  const decisions = notes.filter((n) => n.metadata?.isDecision)
  const questions = notes.filter((n) => n.tags.includes('question') && n.status !== 'done')
  const skills = entities.filter((e) => e.type === 'skill' && e.status !== 'archived')
  const unactioned = ideas.filter((i) => i.status === 'todo')

  const tagCounts: Record<string, number> = {}
  for (const n of notes) for (const t of n.tags) tagCounts[t] = (tagCounts[t] || 0) + 1
  const topTags = Object.entries(tagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
  const projects = entities.filter((e) => e.type === 'project' && e.status !== 'archived')
  const projectSummaries = projects
    .map((p) => {
      const tasks = entities.filter(
        (e) => e.type === 'task' && e.metadata?.projectId === p.id && e.status !== 'archived',
      )
      const doneThisWeek = tasks.filter((t) => t.status === 'done' && t.updatedAt >= weekAgo).length
      const remaining = tasks.filter((t) => t.status !== 'done').length
      const projectNotes = notes.filter((n) =>
        n.tags.some((t) => t.toLowerCase() === p.title.toLowerCase()),
      )
      return `- ${p.title} [${p.status}]: ${doneThisWeek}/wk velocity, ${remaining} remaining, ${projectNotes.length} notes`
    })
    .join('\n')

  const goals = entities.filter(
    (e) => e.type === 'goal' && e.status !== 'done' && e.status !== 'archived',
  )

  return [
    `\n## Knowledge Signals:`,
    `Top themes: ${topTags.map(([t, c]) => `${t}(${c})`).join(', ')}`,
    `Unactioned ideas: ${unactioned.length} (${unactioned.slice(0, 3).map((i) => `"${i.title}"`).join(', ')})`,
    `Open questions: ${questions.length}`,
    `Pending decisions: ${decisions.filter((d) => d.status !== 'done').length}`,
    `Active skills: ${skills.map((s) => `${s.title}[${s.metadata?.mastery ?? 'novice'}]`).join(', ') || 'none tracked'}`,
    `\n## Projects:`,
    projectSummaries,
    `\n## Goals:`,
    goals
      .map((g) => {
        const progress = typeof g.metadata?.progress === 'number' ? g.metadata.progress : 0
        return `- ${g.title} [${g.priority}] ${progress}%${g.dueDate ? ` due:${g.dueDate}` : ''}`
      })
      .join('\n'),
  ].join('\n')
}
