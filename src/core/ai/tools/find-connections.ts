import { registerTool, type AITool } from './registry'
import { getSolPrefix } from '../soul'

const tool: AITool = {
  id: 'find-connections',
  name: 'Find Connections',
  description:
    'Finds non-obvious connections across knowledge, skills, and projects',
  scope: 'global',
  buildPrompt: ({ entities }) => {
    const notes = entities.filter(
      (e) =>
        e.type === 'note' && !e.metadata?.isInbox && e.status !== 'archived',
    )
    const skills = entities.filter(
      (e) => e.type === 'skill' && e.status !== 'archived',
    )
    const books = entities.filter(
      (e) =>
        (e.type === 'book' || e.type === 'course') && e.status !== 'archived',
    )
    const projects = entities.filter(
      (e) => e.type === 'project' && e.status === 'in-progress',
    )
    const goals = entities.filter(
      (e) =>
        e.type === 'goal' && e.status !== 'done' && e.status !== 'archived',
    )
    const staleTasks = entities
      .filter(
        (e) =>
          e.type === 'task' &&
          e.status !== 'done' &&
          e.status !== 'archived',
      )
      .filter((e) => {
        const d = Date.now() - new Date(e.updatedAt).getTime()
        return d > 7 * 86400000
      })

    const knowledgeSection = [
      '## Notes & Ideas:',
      ...notes
        .slice(0, 15)
        .map(
          (n) =>
            `- "${n.title}" [${n.tags.join(', ')}]${n.description ? ': ' + n.description.slice(0, 80) : ''}`,
        ),
      '',
      '## Skills:',
      ...skills.map(
        (s) =>
          `- ${s.title} [${s.metadata?.mastery ?? 'novice'}] domain: ${s.metadata?.domain ?? 'general'}`,
      ),
      '',
      '## Books/Courses:',
      ...books.slice(0, 10).map((b) => `- "${b.title}" [${b.status}]`),
      '',
      '## Active Projects:',
      ...projects.map(
        (p) => `- ${p.title}: ${p.description ?? 'no description'}`,
      ),
      '',
      '## Active Goals:',
      ...goals.map((g) => `- ${g.title} [${g.priority}]`),
      '',
      '## Stuck/Stale Tasks:',
      ...staleTasks
        .slice(0, 10)
        .map(
          (t) =>
            `- "${t.title}" [stale ${Math.floor((Date.now() - new Date(t.updatedAt).getTime()) / 86400000)}d]`,
        ),
    ].join('\n')

    return [
      {
        role: 'system' as const,
        content: [
          getSolPrefix(300),
          '',
          "Find 3-5 NON-OBVIOUS connections across the user's knowledge, skills, and current problems.",
          'Each connection should link something the user KNOWS to something they NEED.',
          '',
          'Connection types:',
          '- Skill -> Task: a skill that solves a current problem',
          '- Book insight -> Habit: an idea from reading that fixes a behavior gap',
          '- Note -> Project: knowledge that accelerates a project',
          '- Skill -> Opportunity: a skill ready to be deployed for growth',
          '- Pattern -> Action: a behavioral pattern that suggests a specific action',
          '',
          'Format each as:',
          '### [TYPE] Connection title',
          'FROM: what the user already has/knows',
          'TO: what it connects to / solves',
          'WHY: why this connection matters',
          '',
          knowledgeSection,
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: "Find the connections I'm not seeing.",
      },
    ]
  },
}

registerTool(tool)
