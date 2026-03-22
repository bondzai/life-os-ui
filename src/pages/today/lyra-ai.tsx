import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Sparkles,
  Send,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useAI } from '@/hooks/use-ai'
import { LyraLoader } from '@/components/lyra-loader'
import { useMorningBrief } from '@/hooks/use-morning-brief'

/* ─── Cache helpers ─── */

const GREETING_KEY = 'lyra:ai-greeting'

function getCachedGreeting(): string | null {
  try {
    const raw = sessionStorage.getItem(GREETING_KEY)
    if (!raw) return null
    const { date, content } = JSON.parse(raw)
    if (date === new Date().toISOString().split('T')[0]) return content
  } catch { /* ignore */ }
  return null
}

function cacheGreeting(content: string) {
  sessionStorage.setItem(GREETING_KEY, JSON.stringify({
    date: new Date().toISOString().split('T')[0],
    content,
  }))
}

/* ─── Lyra AI Component ─── */

export function LyraAI() {
  const { ask, run, status: aiStatus, isOnline, modelName } = useAI()
  const insights = useMorningBrief()

  const [greeting, setGreeting] = useState<string | null>(getCachedGreeting)
  const [greetingLoading, setGreetingLoading] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [answering, setAnswering] = useState(false)
  const autoTriggered = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Generate AI greeting from insights
  const generateGreeting = useCallback(async () => {
    if (insights.length === 0) return
    setGreetingLoading(true)
    try {
      const response = await run('suggest-focus')
      setGreeting(response)
      cacheGreeting(response)
    } catch {
      setGreeting(null)
    } finally {
      setGreetingLoading(false)
    }
  }, [run, insights.length])

  // Auto-generate greeting when AI comes online
  useEffect(() => {
    if (isOnline && insights.length > 0 && !greeting && !greetingLoading && !autoTriggered.current) {
      autoTriggered.current = true
      generateGreeting()
    }
  }, [isOnline, insights.length, greeting, greetingLoading, generateGreeting])

  // Quick ask
  const handleAsk = useCallback(async () => {
    if (!question.trim() || answering) return
    setAnswering(true)
    setAnswer('')
    try {
      let full = ''
      for await (const chunk of ask(question)) {
        full += chunk
        setAnswer(full)
      }
      setQuestion('')
    } catch (err) {
      setAnswer(`Error: ${err instanceof Error ? err.message : 'Failed to connect'}`)
    } finally {
      setAnswering(false)
    }
  }, [question, answering, ask])

  // Algorithmic fallback greeting
  const fallbackGreeting = insights.length > 0
    ? `${insights.length} signal${insights.length > 1 ? 's' : ''} detected. ${
        insights.filter((i) => i.severity >= 2).length > 0
          ? `${insights.filter((i) => i.severity >= 2).length} need attention.`
          : 'All systems nominal.'
      }`
    : 'All systems nominal. No signals detected.'

  return (
    <div className="rounded-lg border bg-card/50 overflow-hidden">
      {/* Header — status bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <Sparkles className={`h-3.5 w-3.5 ${isOnline ? 'text-primary' : 'text-muted-foreground/40'}`} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Lyra
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          {isOnline ? (
            <Wifi className="h-3 w-3 text-emerald-500" />
          ) : (
            <WifiOff className="h-3 w-3 text-muted-foreground/30" />
          )}
          <span className={`text-[9px] font-medium ${isOnline ? 'text-emerald-500' : 'text-muted-foreground/40'}`}>
            {aiStatus === 'checking' ? 'Connecting...' : isOnline ? modelName ?? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Greeting — AI or fallback */}
      <div className="px-3 py-2.5">
        {greetingLoading ? (
          <LyraLoader size={20} label="Thinking..." />
        ) : greeting && isOnline ? (
          <div className="space-y-1">
            <p className="text-xs leading-relaxed text-foreground/90">{greeting}</p>
            <button
              onClick={generateGreeting}
              className="flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-primary transition-colors"
            >
              <RefreshCw className="h-2.5 w-2.5" />
              Refresh
            </button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{fallbackGreeting}</p>
        )}
      </div>

      {/* Quick Ask — only when online */}
      {isOnline && (
        <div className="px-3 pb-2.5">
          <div className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-2 py-1">
            <input
              ref={inputRef}
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAsk() }}
              placeholder="Ask me anything..."
              disabled={answering}
              className="flex-1 bg-transparent text-xs placeholder:text-muted-foreground/30 focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={handleAsk}
              disabled={!question.trim() || answering}
              className="shrink-0 text-muted-foreground hover:text-primary transition-colors disabled:opacity-30"
            >
              {answering ? (
                <LyraLoader size={16} />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          {/* Answer */}
          {answer && (
            <div className="mt-2 px-2 py-1.5 rounded-md bg-primary/5 border border-primary/10">
              <p className="text-xs leading-relaxed text-foreground/80">{answer}</p>
            </div>
          )}
        </div>
      )}

      {/* Offline hint */}
      {!isOnline && aiStatus !== 'checking' && (
        <div className="px-3 pb-2.5">
          <p className="text-[10px] text-muted-foreground/30">
            I'm offline. Start Ollama to wake me up: <code className="text-[9px] bg-muted px-1 py-0.5 rounded">brew services start ollama</code>
          </p>
        </div>
      )}
    </div>
  )
}
