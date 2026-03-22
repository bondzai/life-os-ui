import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { useAI } from '@/hooks/use-ai'
import { useSessionPatterns } from '@/hooks/use-session-patterns'

interface SessionReflectionProps {
  onDismiss: () => void
}

const RATINGS = [
  { label: 'Focused', emoji: '\u{1F525}', value: 3 },
  { label: 'Okay', emoji: '\u{1F610}', value: 2 },
  { label: 'Struggled', emoji: '\u{1F634}', value: 1 },
] as const

export function SessionReflection({ onDismiss }: SessionReflectionProps) {
  const { create: createTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)
  const { ask, isOnline } = useAI()
  const patterns = useSessionPatterns()

  const [note, setNote] = useState('')
  const [saved, setSaved] = useState(false)
  const [insight, setInsight] = useState<string | null>(null)
  const [loadingInsight, setLoadingInsight] = useState(false)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interactedRef = useRef(false)

  // Auto-dismiss after 10 seconds if no interaction
  useEffect(() => {
    dismissTimerRef.current = setTimeout(() => {
      if (!interactedRef.current) onDismiss()
    }, 10_000)
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
  }, [onDismiss])

  const cancelAutoDismiss = () => {
    interactedRef.current = true
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
  }

  const handleRate = async (value: number) => {
    cancelAutoDismiss()

    const tracker = {
      id: crypto.randomUUID(),
      entityId: 'session-quality',
      value,
      unit: 'session-quality',
      note: note.trim() || undefined,
      timestamp: new Date().toISOString(),
      ownerId: currentUser?.id ?? '',
    }

    createTracker.mutate(tracker)
    setSaved(true)
    toast.success('Session quality saved')

    // Generate AI insight if online and patterns available
    if (isOnline && patterns) {
      setLoadingInsight(true)
      try {
        const prompt = `You are Lyra, a focus coach. The user just rated a deep work session ${value}/3. Their patterns: avg quality ${patterns.avgQuality}/3 over ${patterns.totalSessions} sessions, trend is ${patterns.recentTrend}${patterns.bestTimeOfDay ? `, best time: ${patterns.bestTimeOfDay}` : ''}${patterns.bestDayOfWeek ? `, best day: ${patterns.bestDayOfWeek}` : ''}. Give ONE short sentence of insight or encouragement (under 20 words). No emoji.`
        let result = ''
        for await (const chunk of ask(prompt)) {
          result += chunk
        }
        setInsight(result.trim())
      } catch {
        // Silently fail - insight is optional
      } finally {
        setLoadingInsight(false)
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="relative w-full max-w-sm mx-4 rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl"
        onClick={cancelAutoDismiss}
      >
        {/* Close button */}
        <button
          onClick={onDismiss}
          className="absolute top-3 right-3 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>

        {!saved ? (
          <>
            <h3 className="text-lg font-semibold text-zinc-100 text-center mb-5">
              How was this session?
            </h3>

            {/* Rating buttons */}
            <div className="flex gap-3 justify-center mb-4">
              {RATINGS.map((r) => (
                <button
                  key={r.value}
                  onClick={() => handleRate(r.value)}
                  className="flex flex-col items-center gap-1.5 px-4 py-3 rounded-xl bg-zinc-800/60 border border-zinc-700/50 hover:border-zinc-600 hover:bg-zinc-800 transition-all cursor-pointer"
                >
                  <span className="text-2xl">{r.emoji}</span>
                  <span className="text-xs text-zinc-400">{r.label}</span>
                </button>
              ))}
            </div>

            {/* Optional note */}
            <input
              type="text"
              placeholder="Quick note (optional)"
              value={note}
              onChange={(e) => {
                cancelAutoDismiss()
                setNote(e.target.value)
              }}
              onFocus={cancelAutoDismiss}
              className="w-full px-3 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 mb-3"
            />

            {/* Skip */}
            <button
              onClick={onDismiss}
              className="w-full text-center text-xs text-zinc-600 hover:text-zinc-400 transition-colors cursor-pointer"
            >
              Skip
            </button>
          </>
        ) : (
          <div className="text-center py-2">
            <p className="text-sm text-zinc-400 mb-3">Session logged</p>

            {loadingInsight && (
              <p className="text-xs text-zinc-500 animate-pulse">Lyra is thinking...</p>
            )}

            {insight && (
              <p className="text-sm text-zinc-300 italic">{insight}</p>
            )}

            {!isOnline && patterns && (
              <p className="text-xs text-zinc-500 mt-2">
                {patterns.totalSessions} sessions tracked. AI offline for pattern analysis.
              </p>
            )}

            {!patterns && (
              <p className="text-xs text-zinc-500 mt-2">
                {(() => {
                  // We need at least 3 sessions for patterns, show count
                  return 'Need 5+ sessions for pattern analysis.'
                })()}
              </p>
            )}

            <button
              onClick={onDismiss}
              className="mt-4 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
