import { registerTool, type AITool } from './registry'
import { getSolPrefix } from '../sol'
import { buildGlobalContext } from '../context'

const tool: AITool = {
  id: 'strategic-moves',
  name: 'Strategic Moves',
  description: 'Generate high-impact strategic recommendations',
  scope: 'global',
  buildPrompt: ({ entities, trackers }) => {
    const globalContext = buildGlobalContext(entities, trackers)

    // Extract key knowledge signals from entities
    const notes = entities.filter(
      (e) => e.type === 'note' && !e.metadata?.isInbox && e.status !== 'archived',
    )
    const ideas = notes.filter((n) => n.tags.some((t) => ['idea', 'spark'].includes(t)))
    const decisions = notes.filter((n) => n.metadata?.isDecision)
    const questions = notes.filter((n) => n.tags.includes('question') && n.status !== 'done')
    const projects = entities.filter((e) => e.type === 'project' && e.status !== 'archived')
    const goals = entities.filter(
      (e) => e.type === 'goal' && e.status !== 'done' && e.status !== 'archived',
    )
    const skills = entities.filter((e) => e.type === 'skill' && e.status !== 'archived')

    // Unactioned ideas
    const unactioned = ideas.filter((i) => i.status === 'todo')

    // Tags frequency
    const tagCounts: Record<string, number> = {}
    for (const n of notes) for (const t of n.tags) tagCounts[t] = (tagCounts[t] || 0) + 1
    const topTags = Object.entries(tagCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)

    // Project velocity
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
    const projectSummaries = projects
      .map((p) => {
        const tasks = entities.filter(
          (e) =>
            e.type === 'task' && e.metadata?.projectId === p.id && e.status !== 'archived',
        )
        const doneThisWeek = tasks.filter(
          (t) => t.status === 'done' && t.updatedAt >= weekAgo,
        ).length
        const remaining = tasks.filter((t) => t.status !== 'done').length
        const projectNotes = notes.filter((n) =>
          n.tags.some((t) => t.toLowerCase() === p.title.toLowerCase()),
        )
        return `- ${p.title} [${p.status}]: ${doneThisWeek}/wk velocity, ${remaining} remaining, ${projectNotes.length} notes`
      })
      .join('\n')

    const knowledgeSection = [
      `\n## Knowledge Signals:`,
      `Top themes: ${topTags.map(([t, c]) => `${t}(${c})`).join(', ')}`,
      `Unactioned ideas: ${unactioned.length} (${unactioned
        .slice(0, 3)
        .map((i) => `"${i.title}"`)
        .join(', ')})`,
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

    return [
      {
        role: 'system',
        content: [
          getSolPrefix(400),
          '',
          'You are performing a strategic analysis. Based on ALL the data below,',
          'generate exactly 3 strategic moves. Each move should be significant —',
          'not a task, but a strategic shift.',
          '',
          'Move types:',
          '- COMMIT: unactioned idea/thinking worth acting on',
          '- PIVOT: current approach failing, suggest alternative',
          '- PARK: something draining attention without results',
          '- DOUBLE-DOWN: something working, do more of it',
          '- EXPLORE: knowledge gap worth investigating',
          '- CONNECT: two unrelated things that should be linked',
          '- DECIDE: open question that needs resolution',
          '',
          'Format each move as:',
          '### [TYPE] Title',
          'Impact: high/medium | Effort: low/medium/high | Timeframe: this week/month/quarter',
          'Reasoning with specific data references.',
          '',
          globalContext,
          knowledgeSection,
        ].join('\n'),
      },
      { role: 'user', content: 'What are my 3 highest-impact strategic moves right now?' },
    ]
  },
}

registerTool(tool)
