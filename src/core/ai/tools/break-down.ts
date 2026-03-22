import { registerTool, type AITool } from './registry'
import { buildTaskContext } from '../context/task-context'
import { buildGoalContext } from '../context/goal-context'
import { getSolPrefix } from '../sol'

const tool: AITool = {
  id: 'break-down',
  name: 'Break Down',
  description: 'Breaks a task or goal into 3-5 actionable steps',
  scope: ['task', 'goal'],
  buildPrompt: ({ entityId, entities }) => {
    const entity = entities.find((e) => e.id === entityId)
    if (!entity) return [{ role: 'user', content: 'Entity not found.' }]

    const context = entity.type === 'goal'
      ? buildGoalContext(entity, entities)
      : buildTaskContext(entity, entities)

    return [
      {
        role: 'system',
        content: [
          getSolPrefix(100),
          '',
          'Break this into 3-5 specific, actionable steps.',
          'Each step should be concrete and completable in one sitting.',
          'Format as a numbered list. Keep each step under 15 words.',
          '',
          context,
        ].join('\n'),
      },
      { role: 'user', content: `Break down "${entity.title}".` },
    ]
  },
}

registerTool(tool)
