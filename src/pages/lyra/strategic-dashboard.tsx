import { useState, useEffect, useCallback, useRef } from 'react'
import { Sparkles, Wifi, WifiOff, RefreshCw } from 'lucide-react'
import { LyraLoader } from '@/components/lyra-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAI } from '@/hooks/use-ai'
import { getAllTools } from '@/core/ai/tools'

const GREETING_KEY = 'lyra:greeting'
const FOCUS_KEY = 'lyra:focus'

function todayKey(prefix: string) {
  return `${prefix}:${new Date().toDateString()}`
}

export function StrategicDashboard() {
  const { run, isOnline, modelName } = useAI()
  const [greeting, setGreeting] = useState<string | null>(null)
  const [greetingLoading, setGreetingLoading] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)
  const [focusLoading, setFocusLoading] = useState(false)
  const [toolResult, setToolResult] = useState<{ toolId: string; text: string } | null>(null)
  const [toolRunning, setToolRunning] = useState<string | null>(null)
  const greetingFetched = useRef(false)

  const tools = getAllTools()

  // Auto-generate greeting (once per day)
  useEffect(() => {
    if (greetingFetched.current) return
    greetingFetched.current = true

    const cached = sessionStorage.getItem(todayKey(GREETING_KEY))
    if (cached) {
      setGreeting(cached)
      return
    }

    if (!isOnline) {
      setGreeting(getAlgorithmicGreeting())
      return
    }

    setGreetingLoading(true)
    run('suggest-focus')
      .then((result) => {
        const short = result.split('\n')[0].slice(0, 120)
        setGreeting(short)
        sessionStorage.setItem(todayKey(GREETING_KEY), short)
      })
      .catch(() => {
        setGreeting(getAlgorithmicGreeting())
      })
      .finally(() => setGreetingLoading(false))
  }, [isOnline, run])

  // Auto-fetch focus suggestion
  const fetchFocus = useCallback(() => {
    const cached = sessionStorage.getItem(todayKey(FOCUS_KEY))
    if (cached && !focusLoading) {
      setFocus(cached)
      return
    }

    if (!isOnline) return

    setFocusLoading(true)
    run('suggest-focus')
      .then((result) => {
        setFocus(result.slice(0, 200))
        sessionStorage.setItem(todayKey(FOCUS_KEY), result.slice(0, 200))
      })
      .catch(() => setFocus(null))
      .finally(() => setFocusLoading(false))
  }, [isOnline, run, focusLoading])

  useEffect(() => {
    const cached = sessionStorage.getItem(todayKey(FOCUS_KEY))
    if (cached) {
      setFocus(cached)
    } else {
      fetchFocus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRefreshFocus = () => {
    sessionStorage.removeItem(todayKey(FOCUS_KEY))
    setFocus(null)
    fetchFocus()
  }

  const handleToolClick = async (toolId: string, scope: string[] | 'global') => {
    if (scope !== 'global') return
    setToolRunning(toolId)
    try {
      const result = await run(toolId)
      setToolResult({ toolId, text: result })
    } catch {
      setToolResult({ toolId, text: 'Failed to run tool.' })
    } finally {
      setToolRunning(null)
    }
  }

  return (
    <div className="border-b border-border/40 bg-card/30 px-4 py-3 space-y-2">
      <div className="flex items-start gap-6">
        {/* Left: Status + Greeting */}
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            {isOnline ? (
              <Wifi className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-muted-foreground/30" />
            )}
            <span className="font-mono text-[11px] text-muted-foreground">
              {modelName ?? 'disconnected'}
            </span>
            <span
              className={`text-[10px] font-mono ${isOnline ? 'text-emerald-500' : 'text-muted-foreground/30'}`}
            >
              {isOnline ? 'online' : 'offline'}
            </span>
          </div>
          <p className="text-sm text-foreground/80 truncate">
            {greetingLoading ? (
              <LyraLoader size={20} label="Thinking..." />
            ) : (
              greeting ?? getAlgorithmicGreeting()
            )}
          </p>
        </div>

        {/* Center: Quick Action Chips */}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Quick Actions
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tools.map((tool) => (
              <Button
                key={tool.id}
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px] font-mono"
                disabled={toolRunning === tool.id}
                onClick={() => handleToolClick(tool.id, tool.scope)}
              >
                {toolRunning === tool.id ? (
                  <LyraLoader size={20} />
                ) : null}
                {tool.name}
                {tool.scope !== 'global' && (
                  <Badge variant="secondary" className="ml-1 text-[9px] px-1 py-0">
                    select entity
                  </Badge>
                )}
              </Button>
            ))}
          </div>
        </div>

        {/* Right: Focus Suggestion */}
        <div className="w-64 shrink-0">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              Focus
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={handleRefreshFocus}
              disabled={focusLoading}
            >
              <RefreshCw className={`h-3 w-3 ${focusLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <div className="rounded-md bg-primary/5 border border-primary/10 px-2.5 py-1.5">
            {focusLoading ? (
              <LyraLoader size={20} label="Analyzing..." />
            ) : (
              <p className="text-xs text-foreground/80 line-clamp-3">
                {focus ?? 'Connect AI to get focus suggestions.'}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Collapsible tool result */}
      {toolResult && (
        <div className="rounded-md bg-primary/5 border border-primary/10 px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {toolResult.toolId}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 text-[10px]"
              onClick={() => setToolResult(null)}
            >
              Dismiss
            </Button>
          </div>
          <p className="text-xs text-foreground/80 whitespace-pre-wrap">{toolResult.text}</p>
        </div>
      )}
    </div>
  )
}

function getAlgorithmicGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return 'Late hours. High leverage or diminishing returns?'
  if (hour < 12) return 'Morning. Prime execution window. Deploy wisely.'
  if (hour < 17) return 'Afternoon. Maintain momentum or pivot.'
  if (hour < 21) return 'Evening. Wrap critical threads, prep tomorrow.'
  return 'Night. Recovery phase. Protect your sleep.'
}
