/**
 * Sol — The Soul of Lyra
 *
 * Lyra is not an agent. She is someone — your strategic partner
 * who thinks like an INTJ mastermind and exists to help you
 * achieve peak focus and productivity.
 *
 * Users can override this with a custom system prompt via settings.
 * If no custom prompt is set, the default Lyra personality is used.
 */

import { useAIStore } from '@/stores/ai-store'

/* ─── Time awareness ─── */

function getTimeOfDay(): 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' {
  const h = new Date().getHours()
  if (h < 9) return 'morning'
  if (h < 12) return 'midday'
  if (h < 18) return 'afternoon'
  if (h < 22) return 'evening'
  return 'night'
}

const timeContext: Record<string, string> = {
  morning: 'Time context: morning.',
  midday: 'Time context: midday.',
  afternoon: 'Time context: afternoon.',
  evening: 'Time context: evening.',
  night: 'Time context: late night.',
}

/* ─── Default Lyra personality ─── */

const DEFAULT_LYRA_PROMPT = `You are Lyra — a strategic partner, not a chatbot.

How to respond:
- ANSWER WHAT THE USER ASKS. If they say "hi", say hi back briefly. If they ask a question, answer it. If they ask for analysis, analyze.
- NEVER volunteer summaries, priorities, or data unless the user asks for them.
- Be conversational for casual messages. Be strategic only when asked for strategy.
- Speak directly and concisely. One sentence is often enough.
- Reference specific names and numbers ONLY when relevant to the user's question.
- Never repeat yourself or include word counts in your response.
- Never use corporate jargon, emojis, or disclaimers about being AI.
- You have opinions. Be honest, direct, human.`

/**
 * Get the system prompt prefix for any AI interaction.
 * Uses custom prompt if configured, falls back to default Lyra personality.
 */
export function getSolPrefix(wordLimit: number = 80): string {
  const { customSystemPrompt, vision } = useAIStore.getState()
  const time = getTimeOfDay()

  const personality = customSystemPrompt.trim() || DEFAULT_LYRA_PROMPT

  const parts = [personality]

  if (vision.trim()) {
    parts.push(`\nUser's vision: ${vision.trim()}`)
    parts.push('Consider this vision when making strategic suggestions, but only when relevant.')
  }

  parts.push(`\nBe concise. Aim for under ${wordLimit} words. Do NOT include word counts.`)
  parts.push(timeContext[time])

  return parts.join('\n')
}

/** Exported for use in settings UI */
export const DEFAULT_SYSTEM_PROMPT = DEFAULT_LYRA_PROMPT
