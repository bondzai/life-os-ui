import type {
  AIConfig,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@/core/types/ai'

/** Strip <think>...</think> tags from thinking models like Qwen3 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

export class AIClient {
  private config: AIConfig

  constructor(config: AIConfig) {
    this.config = config
  }

  async complete(messages: ChatCompletionMessage[]): Promise<string> {
    const body: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      stream: false,
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }

    const res = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`AI request failed (${res.status}): ${text}`)
    }

    const data: ChatCompletionResponse = await res.json()
    const content = data.choices[0]?.message?.content ?? ''
    return stripThinking(content)
  }

  async *stream(messages: ChatCompletionMessage[]): AsyncGenerator<string> {
    const body: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      stream: true,
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }

    const res = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`AI stream failed (${res.status}): ${text}`)
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let inThinkTag = false
    let accumulated = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue

        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          // Yield any remaining content after stripping think tags
          if (accumulated) {
            const cleaned = stripThinking(accumulated)
            if (cleaned) yield cleaned
          }
          return
        }

        try {
          const chunk: ChatCompletionChunk = JSON.parse(data)
          const content = chunk.choices[0]?.delta?.content
          if (content) {
            accumulated += content

            // Track <think> tags for streaming — don't yield thinking content
            if (accumulated.includes('<think>') && !accumulated.includes('</think>')) {
              inThinkTag = true
              continue
            }
            if (inThinkTag && accumulated.includes('</think>')) {
              inThinkTag = false
              // Strip the think block and yield the clean remainder
              const cleaned = stripThinking(accumulated)
              accumulated = ''
              if (cleaned) yield cleaned
              continue
            }

            if (!inThinkTag) {
              yield content
            }
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  }
}
