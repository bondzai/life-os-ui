import { useCallback } from 'react'
import { useAIStore } from '@/stores/ai-store'
import { useAIHealth } from '@/hooks/use-ai-health'
import { useEntities, useTrackers } from '@/core/hooks'
import { AIClient } from '@/core/ai/ai-client'
import { getTool } from '@/core/ai/tools'
import type { ChatMessage } from '@/core/ai/tools/registry'

const OLLAMA_FALLBACK = {
  provider: 'ollama' as const,
  endpoint: 'http://localhost:11434/v1',
  model: 'llama3.2:1b',
  apiKey: '',
  contextWindow: 8192,
}

export function useAI() {
  const storeConfig = useAIStore((s) => s.config)
  const { status, modelName } = useAIHealth()
  const { items: entities } = useEntities()
  const { items: trackers } = useTrackers()

  const config = storeConfig.endpoint && storeConfig.model ? storeConfig : OLLAMA_FALLBACK
  const isOnline = status === 'online'

  // Create client on demand
  const getClient = useCallback(() => new AIClient(config), [config])

  // Free-form ask with streaming
  const ask = useCallback(
    async function* (prompt: string, systemPrompt?: string): AsyncGenerator<string> {
      const client = getClient()
      const messages: ChatMessage[] = []
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
      messages.push({ role: 'user', content: prompt })

      try {
        for await (const chunk of client.stream(messages)) {
          yield chunk
        }
      } catch {
        // Fallback to non-streaming
        const result = await client.complete(messages)
        yield result
      }
    },
    [getClient],
  )

  // Run a registered tool (non-streaming, returns full result)
  const run = useCallback(
    async (toolId: string, entityId?: string): Promise<string> => {
      const tool = getTool(toolId)
      if (!tool) throw new Error(`AI tool "${toolId}" not found`)

      const messages = tool.buildPrompt({ entityId, entities, trackers })
      const client = getClient()
      return client.complete(messages)
    },
    [getClient, entities, trackers],
  )

  return { ask, run, status, isOnline, modelName }
}
