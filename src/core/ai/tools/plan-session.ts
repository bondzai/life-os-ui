import { registerTool, type AITool } from './registry'
import { buildGlobalContext } from '../context'
import { getSolPrefix } from '../soul'
import { buildCandidateList, getEnergyAverages } from './tool-helpers'

const tool: AITool = {
  id: 'plan-session',
  name: 'Plan Session',
  description: 'Plans optimal deep work session with task order and timing',
  scope: 'global',
  buildPrompt: ({ entities, trackers }) => {
    const context = buildGlobalContext(entities, trackers)
    const hour = new Date().getHours()
    const energy = getEnergyAverages(trackers)
    const tasks = buildCandidateList(entities, 20)

    return [
      {
        role: 'system',
        content: [
          getSolPrefix(150),
          '',
          `Current hour: ${hour}:00. Energy: morning avg ${energy.morning}/5, afternoon avg ${energy.afternoon}/5.`,
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
