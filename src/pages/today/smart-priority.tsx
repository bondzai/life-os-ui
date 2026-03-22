import { useState, useEffect, useCallback } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAI } from '@/hooks/use-ai'
import type { Entity } from '@/core/types'

interface SmartPriorityProps {
  onAccept: (ids: string[]) => void
  candidates: Entity[]
  onManual: () => void
}

interface Suggestion {
  id: string
  title: string
  reason: string
}

const CACHE_KEY = 'lyra:smart-priority-cache'

function getCachedSuggestions(): { date: string; response: string } | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    const today = new Date().toISOString().split('T')[0]
    if (data.date !== today) return null
    return data
  } catch {
    return null
  }
}

function setCachedSuggestions(response: string): void {
  const today = new Date().toISOString().split('T')[0]
  sessionStorage.setItem(CACHE_KEY, JSON.stringify({ date: today, response }))
}

function parseSuggestions(
  response: string,
  candidates: Entity[],
): Suggestion[] {
  const lines = response.split('\n').filter((l) => l.trim())
  const suggestions: Suggestion[] = []
  const idRegex = /\[([^\]]+)\]/

  for (const line of lines) {
    const match = idRegex.exec(line)
    if (!match) continue
    const id = match[1]
    const entity = candidates.find((e) => e.id === id)
    if (!entity) continue

    // Extract reason: everything after the [id]
    const reason = line.slice(line.indexOf(']') + 1).replace(/^\s*/, '').trim()
    suggestions.push({ id, title: entity.title, reason })
    if (suggestions.length >= 3) break
  }

  return suggestions
}

export function SmartPriority({
  onAccept,
  candidates,
  onManual,
}: SmartPriorityProps) {
  const { run, isOnline } = useAI()
  const [loading, setLoading] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [error, setError] = useState(false)

  const fetchSuggestions = useCallback(async () => {
    // Check cache first
    const cached = getCachedSuggestions()
    if (cached) {
      const parsed = parseSuggestions(cached.response, candidates)
      if (parsed.length > 0) {
        setSuggestions(parsed)
        return
      }
    }

    setLoading(true)
    setError(false)
    try {
      const response = await run('suggest-priorities')
      setCachedSuggestions(response)
      const parsed = parseSuggestions(response, candidates)
      if (parsed.length > 0) {
        setSuggestions(parsed)
      } else {
        setError(true)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [run, candidates])

  useEffect(() => {
    if (!isOnline || candidates.length === 0) return
    fetchSuggestions()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // If AI is offline or no candidates, fall through to manual
  if (!isOnline || candidates.length === 0) {
    onManual()
    return null
  }

  // Error state — fall through to manual
  if (error) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-4 text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t generate suggestions.
          </p>
          <button
            className="text-xs text-primary hover:underline"
            onClick={onManual}
          >
            Pick manually
          </button>
        </CardContent>
      </Card>
    )
  }

  // Loading state
  if (loading) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-8 flex flex-col items-center gap-3">
          <Sparkles className="h-5 w-5 text-purple-500 animate-pulse" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Lyra is thinking...
          </div>
        </CardContent>
      </Card>
    )
  }

  // Suggestions ready
  if (suggestions.length > 0) {
    return (
      <Card className="border-purple-500/20 bg-purple-50/5 dark:bg-purple-950/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-purple-500" />
            Lyra suggests:
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="space-y-2">
            {suggestions.map((s, i) => (
              <li key={s.id} className="flex gap-2 text-sm">
                <span className="text-muted-foreground/50 shrink-0 tabular-nums">
                  {i + 1}.
                </span>
                <div className="min-w-0">
                  <span className="font-medium">{s.title}</span>
                  {s.reason && (
                    <span className="text-muted-foreground ml-1.5">
                      — {s.reason}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>

          <div className="flex items-center gap-3 pt-1">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => onAccept(suggestions.map((s) => s.id))}
            >
              Accept
            </Button>
            <button
              className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              onClick={onManual}
            >
              Pick manually
            </button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return null
}
