import { useState, useCallback } from 'react'
import { Sparkles, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { useAI } from '@/hooks/use-ai'
import { LyraLoader } from '@/components/lyra-loader'

const CACHE_PREFIX = 'lyra:ai-action:'

function getCached(key: string): string | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const { date, content } = JSON.parse(raw)
    if (date === new Date().toISOString().split('T')[0]) return content
  } catch { /* ignore */ }
  return null
}

function setCache(key: string, content: string) {
  sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({
    date: new Date().toISOString().split('T')[0],
    content,
  }))
}

interface AIActionProps {
  /** Registered tool ID from the tools registry */
  tool: string
  /** Entity ID to pass to the tool (optional for global tools) */
  entityId?: string
  /** Custom label override */
  label?: string
  /** Compact mode — just an icon button */
  compact?: boolean
}

export function AIAction({ tool, entityId, label, compact }: AIActionProps) {
  const { run, isOnline } = useAI()
  const cacheKey = `${tool}:${entityId ?? 'global'}`

  const [result, setResult] = useState<string | null>(() => getCached(cacheKey))
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(true)

  const execute = useCallback(async () => {
    setLoading(true)
    setResult(null)
    try {
      const response = await run(tool, entityId)
      setResult(response)
      setCache(cacheKey, response)
      setExpanded(true)
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : 'Failed to connect'}`)
    } finally {
      setLoading(false)
    }
  }, [run, tool, entityId, cacheKey])

  // Hidden when AI is offline — graceful degradation
  if (!isOnline) return null

  // Has result — show collapsible response
  if (result) {
    return (
      <div className="rounded-md bg-primary/5 border border-primary/10 overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left hover:bg-primary/5 transition-colors"
        >
          <Sparkles className="h-3 w-3 text-primary shrink-0" />
          <span className="text-[10px] font-medium text-primary flex-1">
            {label ?? 'Lyra'}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); execute() }}
            className="text-muted-foreground/40 hover:text-primary transition-colors"
            title="Regenerate"
          >
            <RefreshCw className="h-2.5 w-2.5" />
          </button>
          {expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground/40" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
          )}
        </button>
        {expanded && (
          <div className="px-2.5 pb-2">
            <p className="text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap">{result}</p>
          </div>
        )}
      </div>
    )
  }

  // No result yet — show trigger button
  if (compact) {
    return (
      <button
        onClick={execute}
        disabled={loading}
        className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-50"
        title={label ?? 'Ask Lyra'}
      >
        {loading ? (
          <LyraLoader size={20} />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
      </button>
    )
  }

  return (
    <button
      onClick={execute}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-50"
    >
      {loading ? (
        <LyraLoader size={20} label="Thinking..." />
      ) : (
        <>
          <Sparkles className="h-3 w-3" />
          {label ?? 'Ask Lyra'}
        </>
      )}
    </button>
  )
}
