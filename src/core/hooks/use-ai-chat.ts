import { useState, useCallback, useMemo } from 'react'
import { AIClient, gatherContext, buildSystemPrompt } from '@/core/ai'
import { useAIStore } from '@/stores/ai-store'
import { useChatStore } from '@/stores/chat-store'
import type { ChatCompletionMessage } from '@/core/types/ai'

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

        // Build context
        const context = await gatherContext()
        const systemPrompt = buildSystemPrompt(context)

        // Build messages array for API
        const currentConv = useChatStore.getState().conversations.find((c) => c.id === convId)
        const apiMessages: ChatCompletionMessage[] = [
          { role: 'system', content: systemPrompt },
          ...(currentConv?.messages ?? []).map((m) => ({
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
