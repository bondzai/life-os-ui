import type {
  AIConfig,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@/core/types/ai'

/** Strip <think>...</think> tags from thinking models */
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
    let thinkBuffer = ''

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
        if (data === '[DONE]') return

        try {
          const chunk: ChatCompletionChunk = JSON.parse(data)
          const content = chunk.choices[0]?.delta?.content
          if (!content) continue

          // Handle <think> tags — buffer thinking content, don't yield it
          if (inThinkTag) {
            thinkBuffer += content
            if (thinkBuffer.includes('</think>')) {
              // Think block ended — extract any content after </think>
              const afterThink = thinkBuffer.split('</think>').pop() ?? ''
              inThinkTag = false
              thinkBuffer = ''
              if (afterThink.trim()) yield afterThink
            }
            continue
          }

          // Check if this chunk starts a think tag
          if (content.includes('<think>')) {
            const beforeThink = content.split('<think>')[0]
            if (beforeThink.trim()) yield beforeThink
            inThinkTag = true
            thinkBuffer = content.split('<think>').slice(1).join('<think>')
            // Check if think ends in same chunk
            if (thinkBuffer.includes('</think>')) {
              const afterThink = thinkBuffer.split('</think>').pop() ?? ''
              inThinkTag = false
              thinkBuffer = ''
              if (afterThink.trim()) yield afterThink
            }
            continue
          }

          // Normal content — yield directly
          yield content
        } catch {
          // skip malformed chunks
        }
      }
    }
  }
}
