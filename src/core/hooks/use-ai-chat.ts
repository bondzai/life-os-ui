import { useState, useCallback, useMemo } from 'react'
import { AIClient, gatherContext, buildSystemPrompt } from '@/core/ai'
import { getSolPrefix } from '@/core/ai/soul'
import { useAIStore } from '@/stores/ai-store'
import { useChatStore } from '@/stores/chat-store'
import { entityRepository } from '@/core/repositories'
import type { ChatCompletionMessage } from '@/core/types/ai'
import type { AIConfig } from '@/core/types/ai'

/**
 * Detect if a message needs app data context.
 * Casual messages (hi, thanks, who are you, etc.) don't need entity data.
 */
function needsDataContext(message: string): boolean {
  const lower = message.toLowerCase().trim()

  // Only inject data when user EXPLICITLY asks about their life OS data
  // using phrases that clearly reference the system
  const dataPatterns = [
    /my (tasks?|goals?|projects?|habits?|streaks?|budgets?|skills?|notes?|events?)/,
    /what should i (focus|do|work|prioritize)/,
    /what('s| is) (overdue|stale|blocked|due|pending)/,
    /how (am i|are my|is my)/,
    /(show|list|check|review) my/,
    /weekly (review|summary|report)/,
    /daily (brief|summary|report)/,
    /suggest (priorities|focus|tasks)/,
    /analyze (my|the)/,
    /what('s| is) my (progress|velocity|status)/,
    /strategic (moves?|plan|board)/,
  ]

  return dataPatterns.some((p) => p.test(lower))
}

async function extractMemoriesBackground(convText: string, config: AIConfig) {
  try {
    const client = new AIClient(config)

    const response = await client.complete([
      {
        role: 'system',
        content: [
          'Extract 0-3 key facts worth remembering from this conversation.',
          'Categories: fact, preference, pattern, decision, context',
          'Respond ONLY with a JSON array: [{"title":"...","category":"...","detail":"..."}]',
          'If nothing worth remembering, return [].',
          'Do NOT extract greetings or trivial exchanges.',
        ].join('\n'),
      },
      { role: 'user', content: convText },
    ])

    // Parse JSON
    const match = response.match(/\[[\s\S]*\]/)
    if (!match) return

    const memories = JSON.parse(match[0]) as Array<{
      title: string
      category: string
      detail?: string
    }>
    if (!Array.isArray(memories) || memories.length === 0) return

    // Save memories as entities
    const existing = await entityRepository.getAll()
    const existingTitles = new Set(
      existing.filter((e) => e.type === 'memory').map((e) => e.title.toLowerCase()),
    )

    for (const mem of memories) {
      if (!mem.title || existingTitles.has(mem.title.toLowerCase())) continue
      await entityRepository.create({
        id: crypto.randomUUID(),
        type: 'memory',
        title: mem.title,
        description: mem.detail ?? undefined,
        status: 'todo',
        priority: 'medium',
        tags: [mem.category ?? 'fact'],
        metadata: { category: mem.category ?? 'fact', source: 'chat', confidence: 0.7 },
        ownerId: '',
        visibility: 'private',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
  } catch {
    // Silent — memory extraction is best-effort
  }
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

        // Inject persistent memories
        try {
          const allEnts = await entityRepository.getAll()
          const memoryEntities = allEnts.filter(
            (e) => e.type === 'memory' && e.status !== 'archived',
          )
          if (memoryEntities.length > 0) {
            systemPrompt +=
              "\n\n## Lyra's Memory:\n" +
              memoryEntities
                .slice(0, 10)
                .map(
                  (m) =>
                    `- [${m.metadata?.category ?? 'fact'}] ${m.title}${m.description ? ': ' + m.description : ''}`,
                )
                .join('\n') +
              "\n\nReference these naturally when relevant. Don't force them."
          }
        } catch {
          // Memory injection is best-effort
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
        let finalResponse = ''
        try {
          let accumulated = ''
          for await (const chunk of client.stream(apiMessages)) {
            accumulated += chunk
            updateMessage(convId, assistantMsgId, accumulated)
          }
          finalResponse = accumulated
        } catch {
          // Fallback to non-streaming
          const response = await client.complete(apiMessages)
          updateMessage(convId, assistantMsgId, response)
          finalResponse = response
        }

        // Background: extract memories (don't await)
        if (content.trim().length > 20 && finalResponse.length > 20) {
          const convText = `User: ${content.trim()}\nLyra: ${finalResponse}`
          extractMemoriesBackground(convText, config).catch(() => {})
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
