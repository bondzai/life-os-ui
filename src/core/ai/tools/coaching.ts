import { registerTool, type AITool } from './registry'
import { buildHabitContext } from '../context/habit-context'
import { getSolPrefix } from '../sol'

const tool: AITool = {
  id: 'coaching',
  name: 'Coach Me',
  description: 'Analyzes habit patterns and suggests improvements',
  scope: ['habit'],
  buildPrompt: ({ entityId, entities, trackers }) => {
    const habit = entities.find((e) => e.id === entityId)
    if (!habit) return [{ role: 'user', content: 'Habit not found.' }]

    const context = buildHabitContext(habit, trackers)

    return [
      {
        role: 'system',
        content: [
          getSolPrefix(60),
          '',
          'Give ONE specific, actionable suggestion for this habit.',
          'Look at: streak length, weekly patterns (which days are missed), completion rate.',
          'Be encouraging but honest.',
          '',
          context,
        ].join('\n'),
      },
      { role: 'user', content: `Coach me on "${habit.title}".` },
    ]
  },
}

registerTool(tool)
