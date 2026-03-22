import { registerTool, type AITool } from './registry'
import { buildGlobalContext } from '../context'
import { getSolPrefix } from '../soul'

const tool: AITool = {
  id: 'suggest-priorities',
  name: 'Suggest Priorities',
  description: 'Suggests 3 tasks for today focus',
  scope: 'global',
  buildPrompt: ({ entities, trackers }) => {
    const today = new Date().toISOString().split('T')[0]
    const context = buildGlobalContext(entities, trackers)

    // List available tasks/goals for selection
    const candidates = entities
      .filter(
        (e) =>
          (e.type === 'task' || e.type === 'goal') &&
          (e.status === 'todo' || e.status === 'in-progress'),
      )
      .slice(0, 30)
      .map(
        (e) =>
          `- [${e.id}] "${e.title}" [${e.type}/${e.priority}]${e.dueDate ? ` due:${e.dueDate}` : ''}`,
      )
      .join('\n')

    return [
      {
        role: 'system',
        content: [
          getSolPrefix(200),
          '',
          "Pick exactly 3 items from the candidate list below for today's focus.",
          `Today is ${today}.`,
          'Consider: urgency (overdue/due soon), leverage (unblocks other things), momentum (continue recent work), and variety.',
          'For each, explain WHY in one short sentence.',
          '',
          'IMPORTANT: Respond in this exact format:',
          '1. [exact-entity-id] reason',
          '2. [exact-entity-id] reason',
          '3. [exact-entity-id] reason',
          '',
          'Use the exact IDs from the brackets in the candidate list.',
          '',
          '## Available candidates:',
          candidates,
          '',
          '## Current context:',
          context,
        ].join('\n'),
      },
      { role: 'user', content: 'Pick my 3 priorities for today.' },
    ]
  },
}

registerTool(tool)
