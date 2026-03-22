import { registerTool, type AITool } from './registry'
import { buildGlobalContext } from '../context'
import { getSolPrefix } from '../soul'

const tool: AITool = {
  id: 'weekly-summary',
  name: 'Weekly Summary',
  description: 'Generates a narrative weekly review',
  scope: 'global',
  buildPrompt: ({ entities, trackers }) => {
    const context = buildGlobalContext(entities, trackers)

    return [
      {
        role: 'system',
        content: [
          getSolPrefix(150),
          '',
          'Write a brief weekly summary covering:',
          '1. What went well (accomplishments, streaks maintained)',
          '2. What needs attention (stalling projects, missed habits, overdue)',
          '3. One specific recommendation for next week',
          '',
          context,
        ].join('\n'),
      },
      { role: 'user', content: 'Give me my weekly review.' },
    ]
  },
}

registerTool(tool)
