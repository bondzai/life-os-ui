import { registerTool, type AITool } from './registry'

const tool: AITool = {
  id: 'extract-memories',
  name: 'Extract Memories',
  description: 'Extracts key facts from a conversation to remember',
  scope: 'global',
  buildPrompt: ({ entities }) => {
    // The conversation text will be injected by the caller via entities hack
    const convEntity = entities.find((e) => e.id === '__conversation__')
    const conversationText = convEntity?.description ?? ''

    return [
      {
        role: 'system',
        content: [
          'You extract key facts worth remembering from conversations.',
          'ONLY extract things that would be useful in FUTURE conversations.',
          '',
          'Categories:',
          '- fact: concrete info about the user (name, role, preferences)',
          '- preference: likes, dislikes, work style preferences',
          '- pattern: recurring behaviors or habits noticed',
          '- decision: important decisions or choices made',
          '- context: project/goal context that helps understand future questions',
          '',
          'Respond ONLY with a JSON array. No other text.',
          'Each item: { "title": "...", "category": "...", "detail": "..." }',
          'Extract 0-3 items. If nothing worth remembering, return [].',
          'Do NOT extract trivial things like greetings.',
          '',
          '## Conversation:',
          conversationText,
        ].join('\n'),
      },
      { role: 'user', content: 'Extract memories from this conversation.' },
    ]
  },
}

registerTool(tool)
