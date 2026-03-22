import { registerTool, type AITool } from './registry'
import { buildGlobalContext } from '../context'
import { getSolPrefix } from '../soul'

const tool: AITool = {
  id: 'plan-session',
  name: 'Plan Session',
  description: 'Plans optimal deep work session with task order and timing',
  scope: 'global',
  buildPrompt: ({ entities, trackers }) => {
    const context = buildGlobalContext(entities, trackers)
    const hour = new Date().getHours()

    // Energy data
    const energyTrackers = trackers.filter((t) => t.unit === 'energy')
    const morningAvg = energyTrackers.filter((t) => t.note === 'morning')
    const afternoonAvg = energyTrackers.filter((t) => t.note === 'afternoon')
    const avgM =
      morningAvg.length > 0
        ? (morningAvg.reduce((s, t) => s + t.value, 0) / morningAvg.length).toFixed(1)
        : 'unknown'
    const avgA =
      afternoonAvg.length > 0
        ? (afternoonAvg.reduce((s, t) => s + t.value, 0) / afternoonAvg.length).toFixed(1)
        : 'unknown'

    // Available tasks
    const tasks = entities
      .filter((e) => e.type === 'task' && (e.status === 'todo' || e.status === 'in-progress'))
      .slice(0, 20)
      .map((e) => {
        const points = e.metadata?.points as number | undefined
        return `- [${e.id}] "${e.title}" [${e.priority}]${points ? ` est:${points}pts` : ''}${e.dueDate ? ` due:${e.dueDate}` : ''}`
      })
      .join('\n')

    return [
      {
        role: 'system',
        content: [
          getSolPrefix(150),
          '',
          `Current hour: ${hour}:00. Energy: morning avg ${avgM}/5, afternoon avg ${avgA}/5.`,
          '',
          'Plan a deep work session. Pick 2-4 tasks, order them by optimal sequence.',
          'Consider: energy level at current hour, task difficulty, deadlines, momentum.',
          '',
          'Respond in this exact format:',
          '1. [exact-entity-id] ~Xmin — reason',
          '2. [exact-entity-id] ~Xmin — reason',
          '3. [exact-entity-id] ~Xmin — reason',
          '',
          'Then add: "Total: ~Xh"',
          '',
          '## Available tasks:',
          tasks,
          '',
          context,
        ].join('\n'),
      },
      { role: 'user', content: 'Plan my deep work session.' },
    ]
  },
}

registerTool(tool)
