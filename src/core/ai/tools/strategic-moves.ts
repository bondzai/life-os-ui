import { registerTool, type AITool } from './registry'
import { getSolPrefix } from '../soul'
import { buildGlobalContext } from '../context'
import { buildKnowledgeSignals } from './tool-helpers'

const tool: AITool = {
  id: 'strategic-moves',
  name: 'Strategic Moves',
  description: 'Generate high-impact strategic recommendations',
  scope: 'global',
  buildPrompt: ({ entities, trackers }) => {
    const globalContext = buildGlobalContext(entities, trackers)
    const knowledgeSection = buildKnowledgeSignals(entities)

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
