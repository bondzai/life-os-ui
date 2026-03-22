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
    model: 'llama3.2:3b',
    apiKey: '',
    contextWindow: 8192,
  },
  custom: {
    provider: 'custom',
    endpoint: '',
    model: '',
    apiKey: '',
    contextWindow: 4096,
  },
}

interface AIState {
  config: AIConfig
  isConfigured: boolean
  /** User-customizable system prompt. Empty = use default Lyra personality. */
  customSystemPrompt: string
  /** User's long-term vision. Lyra considers this in strategic recommendations. */
  vision: string
  setConfig: (config: AIConfig) => void
  switchProvider: (provider: AIProvider) => void
  setCustomSystemPrompt: (prompt: string) => void
  setVision: (vision: string) => void
  resetConfig: () => void
}

export const useAIStore = create<AIState>()(
  persist(
    (set) => ({
      config: DEFAULT_CONFIGS.ollama,
      isConfigured: false,
      customSystemPrompt: '',
      vision: '',
      setConfig: (config) =>
        set({ config, isConfigured: !!config.endpoint && !!config.model }),
      switchProvider: (provider) => {
        const config = DEFAULT_CONFIGS[provider]
        set({ config, isConfigured: !!config.endpoint && !!config.model })
      },
      setCustomSystemPrompt: (prompt) => set({ customSystemPrompt: prompt }),
      setVision: (vision) => set({ vision }),
      resetConfig: () => set({ config: DEFAULT_CONFIGS.ollama, isConfigured: false, customSystemPrompt: '', vision: '' }),
    }),
    { name: 'lyra:ai' },
  ),
)
