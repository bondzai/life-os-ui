export type AIProvider = 'openai' | 'claude' | 'ollama' | 'custom'

export interface AIConfig {
  provider: AIProvider
  endpoint: string
  model: string
  apiKey: string
  contextWindow: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
}

export interface ChatConversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
}

// OpenAI-compatible wire types
export interface ChatCompletionMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatCompletionMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
}

export interface ChatCompletionResponse {
  id: string
  choices: { index: number; message: ChatCompletionMessage; finish_reason: string }[]
}

export interface ChatCompletionChunk {
  id: string
  choices: { index: number; delta: { content?: string }; finish_reason: string | null }[]
}

export interface CommandAction {
  id: string
  label: string
  description: string
  category: string
  handler: () => void
}
