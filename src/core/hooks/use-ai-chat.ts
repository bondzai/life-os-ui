import { useState, useCallback, useMemo } from 'react'
import { AIClient, gatherContext, buildSystemPrompt } from '@/core/ai'
import { getSolPrefix } from '@/core/ai/soul'
import { useAIStore } from '@/stores/ai-store'
import { useChatStore } from '@/stores/chat-store'
import type { ChatCompletionMessage } from '@/core/types/ai'

/**
 * Detect if a message needs app data context.
 * Casual messages (hi, thanks, who are you, etc.) don't need entity data.
 */
function needsDataContext(message: string): boolean {
  const lower = message.toLowerCase().trim()

  // Short casual messages — no data needed
  if (lower.length < 15) {
    const casual = ['hi', 'hey', 'hello', 'sup', 'yo', 'thanks', 'thank you', 'ok', 'okay',
      'cool', 'nice', 'great', 'good', 'bye', 'see you', 'gm', 'gn', 'who are you',
      'what are you', 'how are you', 'what can you do', 'help']
    if (casual.some((c) => lower === c || lower.startsWith(c + ' ') || lower.startsWith(c + '?') || lower.startsWith(c + '!'))) {
      return false
    }
  }

  // Keywords that signal data-aware questions
  const dataKeywords = [
    'task', 'goal', 'project', 'habit', 'streak', 'budget', 'spend', 'health', 'sleep',
    'focus', 'priority', 'overdue', 'deadline', 'velocity', 'progress', 'plan', 'review',
    'suggest', 'recommend', 'analyze', 'what should', 'what to', 'how am i', 'how is',
    'status', 'summary', 'brief', 'strategy', 'schedule', 'calendar', 'event',
    'decision', 'skill', 'note', 'idea', 'stale', 'blocked',
  ]

  return dataKeywords.some((kw) => lower.includes(kw))
}

export function useAIChat() {
  const [isLoading, setIsLoading] = useState(false)
  const storeConfig = useAIStore((s) => s.config)
  const OLLAMA_FALLBACK = { provider: 'ollama' as const, endpoint: 'http://localhost:11434/v1', model: 'qwen3:4b', apiKey: '', contextWindow: 8192 }
  const config = storeConfig.endpoint && storeConfig.model ? storeConfig : OLLAMA_FALLBACK
  const isConfigured = !!(config.endpoint && config.model)

  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const createConversation = useChatStore((s) => s.createConversation)
  const addMessage = useChatStore((s) => s.addMessage)
  const updateMessage = useChatStore((s) => s.updateMessage)

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  )

  const sendMessage = useCallback(
    async (content: string) => {
      if (!isConfigured || !content.trim()) return

      setIsLoading(true)
      try {
        // Ensure there's an active conversation
        let convId = activeConversationId
        if (!convId) {
          convId = createConversation()
        }

        // Add user message
        const userMsg = {
          id: crypto.randomUUID(),
          role: 'user' as const,
          content: content.trim(),
          timestamp: new Date().toISOString(),
        }
        addMessage(convId, userMsg)

        // Build system prompt — only inject data when the question needs it
        let systemPrompt: string
        if (needsDataContext(content)) {
          const context = await gatherContext()
          systemPrompt = buildSystemPrompt(context)
        } else {
          systemPrompt = getSolPrefix(100)
        }

        // Build messages array for API
        const currentConv = useChatStore.getState().conversations.find((c) => c.id === convId)
        const apiMessages: ChatCompletionMessage[] = [
          { role: 'system', content: systemPrompt },
          ...(currentConv?.messages ?? [])
            .filter((m) => m.role !== 'system')
            .map((m) => ({
              role: m.role,
              content: m.content,
            })),
        ]

        // Create placeholder assistant message
        const assistantMsgId = crypto.randomUUID()
        addMessage(convId, {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
        })

        // Try streaming first, fall back to non-streaming
        const client = new AIClient(config)
        try {
          let accumulated = ''
          for await (const chunk of client.stream(apiMessages)) {
            accumulated += chunk
            updateMessage(convId, assistantMsgId, accumulated)
          }
        } catch {
          // Fallback to non-streaming
          const response = await client.complete(apiMessages)
          updateMessage(convId, assistantMsgId, response)
        }
      } catch (error) {
        // Add error as assistant message
        const convId = activeConversationId ?? useChatStore.getState().activeConversationId
        if (convId) {
          addMessage(convId, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `Error: ${error instanceof Error ? error.message : 'Something went wrong'}`,
            timestamp: new Date().toISOString(),
          })
        }
      } finally {
        setIsLoading(false)
      }
    },
    [config, isConfigured, activeConversationId, createConversation, addMessage, updateMessage],
  )

  return { activeConversation, isLoading, isConfigured, sendMessage }
}
