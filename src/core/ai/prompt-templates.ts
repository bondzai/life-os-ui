export interface PromptTemplate {
  id: string
  label: string
  description: string
  prompt: string
}

export const promptTemplates: PromptTemplate[] = [
  {
    id: 'daily-brief',
    label: 'Daily Brief',
    description: 'Get a summary of your day',
    prompt: 'Give me a daily brief for today. What should I focus on?',
  },
  {
    id: 'task-breakdown',
    label: 'Task Breakdown',
    description: 'Break down a goal into actionable tasks',
    prompt:
      'Look at my current goals and suggest a breakdown of the most important one into smaller actionable tasks.',
  },
  {
    id: 'weekly-review',
    label: 'Weekly Review',
    description: 'Review your week and plan ahead',
    prompt:
      'Based on my tasks and goals, give me a weekly review. What did I accomplish? What needs attention next week?',
  },
]
