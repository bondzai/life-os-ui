import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AIConfig, AIProvider } from '@/core/types/ai'

const DEFAULT_CONFIGS: Record<AIProvider, AIConfig> = {
  openai: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    contextWindow: 128000,
  },
  claude: {
    provider: 'claude',
    endpoint: 'http://localhost:8080/v1',
    model: 'claude-sonnet-4-20250514',
    apiKey: '',
    contextWindow: 200000,
  },
  ollama: {
    provider: 'ollama',
    endpoint: 'http://localhost:11434/v1',
    model: 'qwen3:4b',
    apiKey: '',
    contextWindow: 32768,
  },
  grok: {
    provider: 'grok',
    endpoint: 'https://api.x.ai/v1',
    model: 'grok-3-mini',
    apiKey: '',
    contextWindow: 131072,
  },
  groq: {
    provider: 'groq',
    endpoint: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    apiKey: '',
    contextWindow: 128000,
  },
  gemini: {
    provider: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    apiKey: '',
    contextWindow: 1048576,
  },
  custom: {
    provider: 'custom',
    endpoint: '',
    model: '',
    apiKey: '',
    contextWindow: 4096,
  },
}

export type NotificationLevel = 'full' | 'minimal' | 'off'

interface AIState {
  config: AIConfig
  isConfigured: boolean
  /** User-customizable system prompt. Empty = use default Lyra personality. */
  customSystemPrompt: string
  /** User's long-term vision. Lyra considers this in strategic recommendations. */
  vision: string
  /** Controls proactive notifications: full = all, minimal = critical only, off = silent */
  notificationLevel: NotificationLevel
  setConfig: (config: AIConfig) => void
  switchProvider: (provider: AIProvider) => void
  setCustomSystemPrompt: (prompt: string) => void
  setVision: (vision: string) => void
  setNotificationLevel: (level: NotificationLevel) => void
  resetConfig: () => void
}

export const useAIStore = create<AIState>()(
  persist(
    (set) => ({
      config: DEFAULT_CONFIGS.ollama,
      isConfigured: false,
      customSystemPrompt: '',
      vision: '',
      notificationLevel: 'full',
      setConfig: (config) =>
        set({ config, isConfigured: !!config.endpoint && !!config.model }),
      switchProvider: (provider) => {
        const config = DEFAULT_CONFIGS[provider]
        set({ config, isConfigured: !!config.endpoint && !!config.model })
      },
      setCustomSystemPrompt: (prompt) => set({ customSystemPrompt: prompt }),
      setVision: (vision) => set({ vision }),
      setNotificationLevel: (level) => set({ notificationLevel: level }),
      resetConfig: () => set({ config: DEFAULT_CONFIGS.ollama, isConfigured: false, customSystemPrompt: '', vision: '', notificationLevel: 'full' }),
    }),
    { name: 'lyra:ai' },
  ),
)
