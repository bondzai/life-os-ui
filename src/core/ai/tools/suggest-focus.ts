import { registerTool, type AITool } from './registry'
import { buildGlobalContext } from '../context'
import { getSolPrefix } from '../sol'

const tool: AITool = {
  id: 'suggest-focus',
  name: 'What to Focus On',
  description: 'Suggests the single most important thing to do right now',
  scope: 'global',
  buildPrompt: ({ entities, trackers }) => {
    const context = buildGlobalContext(entities, trackers)
    return [
      {
        role: 'system',
        content: [
          getSolPrefix(80),
          '',
          'Suggest the ONE most important thing to focus on right now.',
          'Consider: overdue tasks, approaching deadlines, stalling projects, breaking habit streaks.',
          '',
          context,
        ].join('\n'),
      },
      { role: 'user', content: 'What should I focus on right now?' },
    ]
  },
}

registerTool(tool)
