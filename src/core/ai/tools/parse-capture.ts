import { registerTool, type AITool } from './registry'
import { getSolPrefix } from '../soul'
import { isGoal } from '@/core/types'

const tool: AITool = {
  id: 'parse-capture',
  name: 'Parse Capture',
  description: 'Parses natural language into entity data',
  scope: 'global',
  buildPrompt: ({ entities }) => {
    const projects = entities
      .filter((e) => isGoal(e) && e.status !== 'archived')
      .map((e) => `- "${e.title}" [id:${e.id}]`)
      .join('\n')
    const goals = projects // same as projects — isGoal covers both

    const today = new Date().toISOString().split('T')[0]
    const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' })

    return [
      {
        role: 'system' as const,
        content: [
          getSolPrefix(100),
          '',
          `Today is ${today} (${dayOfWeek}).`,
          '',
          "Parse the user's natural language input into a structured entity.",
          'Respond ONLY with valid JSON, no other text:',
          '{',
          '  "type": "task"|"goal"|"habit"|"note"|"event",',
          '  "title": "clean concise title",',
          '  "priority": "low"|"medium"|"high"|"urgent",',
          '  "dueDate": "YYYY-MM-DD or null",',
          '  "projectId": "matched project id or null",',
          '  "goalId": "matched goal id or null",',
          '  "tags": ["tag1", "tag2"],',
          '  "subtasks": ["step 1", "step 2"] or []',
          '}',
          '',
          'Rules:',
          '- Infer type from context (action=task, recurring=habit, outcome=goal, info=note, time-specific=event)',
          '- Extract due dates: "tomorrow"=tomorrow, "friday"=next friday, "next week"=+7 days',
          '- Match project/goal names mentioned in text to existing ones below',
          '- Set priority based on urgency words: "urgent"/"asap"=urgent, "important"=high, default=medium',
          '- Suggest 2-4 subtasks only for tasks that are complex enough',
          '',
          '## Existing Projects:',
          projects || '(none)',
          '',
          '## Existing Goals:',
          goals || '(none)',
        ].join('\n'),
      },
      { role: 'user' as const, content: '' },
    ]
  },
}

registerTool(tool)
