import { registerTool, type AITool } from './registry'
import { buildGoalContext } from '../context/goal-context'
import { buildProjectContext } from '../context/project-context'
import { getSolPrefix } from '../soul'

const tool: AITool = {
  id: 'analyze-risk',
  name: 'Risk Analysis',
  description: 'Analyzes deadline risk and velocity for a goal or project',
  scope: ['goal', 'project'],
  buildPrompt: ({ entityId, entities }) => {
    const entity = entities.find((e) => e.id === entityId)
    if (!entity) return [{ role: 'user', content: 'Entity not found.' }]

    const context = entity.type === 'goal'
      ? buildGoalContext(entity, entities)
      : buildProjectContext(entity, entities)

    return [
      {
        role: 'system',
        content: [
          getSolPrefix(100),
          '',
          'Analyze this for risks. Consider:',
          '- Will it meet its deadline at current pace?',
          '- What are the biggest blockers?',
          '- What should change to get back on track?',
          '',
          context,
        ].join('\n'),
      },
      { role: 'user', content: `Analyze risks for "${entity.title}".` },
    ]
  },
}

registerTool(tool)
