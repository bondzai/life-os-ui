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
  {
    id: 'priority-advice',
    label: 'What to Focus On',
    description: 'AI suggests your top priority right now',
    prompt:
      'Looking at my projects, tasks, goals, and habits — what is the single most important thing I should focus on right now and why? Be specific and decisive.',
  },
  {
    id: 'project-status',
    label: 'Project Health Check',
    description: 'Analyze project velocity and risks',
    prompt:
      'Analyze my active projects. Which ones are on track? Which are stalling? What should I do about the stalling ones? Be specific with project names.',
  },
  {
    id: 'habit-coaching',
    label: 'Habit Coach',
    description: 'Get advice on your habits and streaks',
    prompt:
      'Look at my habits and their streaks. Which habits am I doing well on? Which need attention? Give me one specific suggestion to improve my consistency.',
  },
  {
    id: 'web-search',
    label: 'Web Search',
    description: 'Search the web for information',
    prompt: '/search ',
  },
  {
    id: 'life-balance',
    label: 'Life Balance Check',
    description: 'Are you neglecting any life domain?',
    prompt:
      'Based on my data across health, wealth, learning, and other life domains — which areas am I neglecting? Give me one actionable suggestion for each neglected area.',
  },
]
