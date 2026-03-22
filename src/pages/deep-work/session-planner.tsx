import { useState, useEffect, useCallback } from 'react'
import { Sparkles, Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAI } from '@/hooks/use-ai'

const SESSION_STORAGE_KEY = 'lyra:session-plan'

interface SessionPlannerProps {
  onStartSession: (entityIds: string[]) => void
  onSkip: () => void
}

function parseEntityIds(text: string): string[] {
  const matches = text.matchAll(/\[([^\]]+)\]/g)
  const ids: string[] = []
  for (const m of matches) {
    const id = m[1]
    // Filter out non-id bracket content (like priorities, labels)
    if (id && id.length > 8 && !['urgent', 'high', 'medium', 'low', 'todo', 'in-progress', 'done'].includes(id)) {
      ids.push(id)
    }
  }
  // Deduplicate
  return [...new Set(ids)]
}

export function SessionPlanner({ onStartSession, onSkip }: SessionPlannerProps) {
  const { run, isOnline } = useAI()
  const [plan, setPlan] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [entityIds, setEntityIds] = useState<string[]>([])

  const fetchPlan = useCallback(async () => {
    // Check sessionStorage cache first
    const cached = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (cached) {
      setPlan(cached)
      setEntityIds(parseEntityIds(cached))
      return
    }

    setLoading(true)
    setError(false)
    try {
      const result = await run('plan-session')
      setPlan(result)
      setEntityIds(parseEntityIds(result))
      sessionStorage.setItem(SESSION_STORAGE_KEY, result)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [run])

  useEffect(() => {
    if (isOnline) {
      fetchPlan()
    }
  }, [isOnline]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOnline) return null

  if (loading) {
    return (
      <div className="w-full max-w-md mx-auto text-center space-y-4 py-8">
        <Loader2 className="h-6 w-6 mx-auto text-primary/50 animate-spin" />
        <p className="text-sm text-zinc-500">Planning your session...</p>
      </div>
    )
  }

  if (error || !plan) {
    return null
  }

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="rounded-xl border border-primary/10 bg-white/[0.02] p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-2 text-primary/70">
          <Sparkles className="h-4 w-4" />
          <span className="text-sm font-medium">Session Plan</span>
        </div>

        {/* Plan text */}
        <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
          {plan}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1">
          <Button
            onClick={() => {
              sessionStorage.removeItem(SESSION_STORAGE_KEY)
              onStartSession(entityIds)
            }}
            disabled={entityIds.length === 0}
            className="gap-2 bg-amber-500 hover:bg-amber-400 text-black font-medium rounded-full px-6"
          >
            <Play className="h-4 w-4" />
            Start Session
          </Button>
          <button
            onClick={() => {
              sessionStorage.removeItem(SESSION_STORAGE_KEY)
              onSkip()
            }}
            className="text-xs text-zinc-500 hover:text-zinc-400 transition-colors cursor-pointer"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}
