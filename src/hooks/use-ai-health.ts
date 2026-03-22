import { useState, useEffect, useCallback } from 'react'
import { useAIStore } from '@/stores/ai-store'

export type AIStatus = 'online' | 'offline' | 'checking'

const CHECK_INTERVAL = 30_000 // 30s
const TIMEOUT = 3_000 // 3s timeout for health check
const OLLAMA_DEFAULT = 'http://localhost:11434'

export function useAIHealth() {
  const config = useAIStore((s) => s.config)
  const [status, setStatus] = useState<AIStatus>('checking')
  const [modelName, setModelName] = useState<string | null>(null)

  // Resolve the base URL — try config endpoint, fallback to Ollama default
  const baseUrl = (config.endpoint || OLLAMA_DEFAULT).replace(/\/v1$/, '')

  const check = useCallback(async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT)

      const res = await fetch(baseUrl, { signal: controller.signal })
      clearTimeout(timer)

      if (res.ok) {
        setStatus('online')
        setModelName(config.model || 'llama3.2:3b')
        return true
      }
      setStatus('offline')
      setModelName(null)
      return false
    } catch {
      setStatus('offline')
      setModelName(null)
      return false
    }
  }, [baseUrl, config.model])

  useEffect(() => {
    check()
    const interval = setInterval(check, CHECK_INTERVAL)
    return () => clearInterval(interval)
  }, [check])

  return { status, modelName, check }
}
