import { useState, useMemo } from 'react'
import { ChevronLeft, ChevronRight, Flame, Sparkles } from 'lucide-react'
import { useEntities, useTrackers } from '@/core/hooks'
import type { Entity } from '@/core/types'

interface LyraCoachProps {
  phase: 'idle' | 'work' | 'break' | 'long-break'
  completedSessions: number
  entityIds: string[]
}

type Subtask = { id: string; title: string; done: boolean; status?: string }

function stDone(s: Subtask): boolean {
  return s.status === 'done' || s.done
}

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

export function LyraCoach({ phase, completedSessions, entityIds }: LyraCoachProps) {
  const [collapsed, setCollapsed] = useState(true)
  const { items: allEntities } = useEntities()
  const { items: allTrackers } = useTrackers()

  // --- Streak alerts: habits with streak >= 3 not checked today ---
  const streakAlerts = useMemo(() => {
    const habits = allEntities.filter((e) => e.type === 'habit')
    const today = new Date().toISOString().slice(0, 10)

    return habits
      .filter((h) => {
        const streak = typeof h.metadata.streak === 'number' ? h.metadata.streak : 0
        if (streak < 3) return false
        // Check if tracked today
        const trackedToday = allTrackers.some(
          (t) => t.entityId === h.id && t.timestamp.slice(0, 10) === today,
        )
        return !trackedToday
      })
      .sort((a, b) => {
        const sa = typeof a.metadata.streak === 'number' ? a.metadata.streak : 0
        const sb = typeof b.metadata.streak === 'number' ? b.metadata.streak : 0
        return sb - sa
      })
      .slice(0, 2)
      .map((h) => {
        const streak = typeof h.metadata.streak === 'number' ? h.metadata.streak : 0
        const now = new Date()
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)
        const hoursLeft = Math.max(0, Math.round((endOfDay.getTime() - now.getTime()) / 3600000))
        return { id: h.id, title: h.title, streak, hoursLeft }
      })
  }, [allEntities, allTrackers])

  // --- Entities being worked on with subtask counts ---
  const workEntities = useMemo(() => {
    return entityIds
      .map((id) => allEntities.find((e) => e.id === id))
      .filter(Boolean)
      .map((e) => {
        const entity = e as Entity
        const subs = Array.isArray(entity.metadata.subtasks)
          ? (entity.metadata.subtasks as Subtask[])
          : []
        const done = subs.filter(stDone).length
        return { id: entity.id, title: entity.title, done, total: subs.length }
      })
  }, [entityIds, allEntities])

  // --- Next up: highest priority incomplete task NOT in current entityIds ---
  const nextUp = useMemo(() => {
    const entityIdSet = new Set(entityIds)
    const candidates = allEntities.filter(
      (e) =>
        e.type === 'task' &&
        e.status !== 'done' &&
        e.status !== 'archived' &&
        !entityIdSet.has(e.id),
    )
    candidates.sort(
      (a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3),
    )
    return candidates[0] ?? null
  }, [allEntities, entityIds])

  // Only show content during work phase
  const showContent = phase === 'work'

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="fixed right-0 top-1/2 -translate-y-1/2 z-40 h-8 w-6 flex items-center justify-center rounded-l-md bg-zinc-800/60 hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer border border-r-0 border-zinc-700/40"
        title="Lyra Coach"
      >
        <ChevronLeft className="h-3 w-3" />
      </button>
    )
  }

  return (
    <div className="fixed right-0 top-1/2 -translate-y-1/2 z-40 w-64 max-h-[60vh] overflow-y-auto rounded-l-lg bg-zinc-900/95 border border-r-0 border-zinc-700/40 shadow-xl shadow-black/30">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500 font-medium">
          <Sparkles className="h-3 w-3" />
          Coach
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="p-0.5 rounded hover:bg-white/5 text-zinc-600 hover:text-zinc-400 transition-colors cursor-pointer"
        >
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>

      {showContent ? (
        <div className="px-3 py-2 space-y-3">
          {/* Streak Alerts */}
          {streakAlerts.length > 0 && (
            <div className="space-y-1">
              {streakAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex items-start gap-1.5 text-xs text-amber-400/90"
                >
                  <Flame className="h-3 w-3 shrink-0 mt-0.5 text-orange-500" />
                  <span className="min-w-0">
                    <span className="font-medium">{alert.title}</span>
                    <span className="text-zinc-500"> ({alert.streak}d)</span>
                    <span className="text-zinc-600"> — not checked</span>
                    {alert.hoursLeft <= 6 && (
                      <span className="text-red-400/70 text-[10px] ml-1">
                        {alert.hoursLeft}h left
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Session Progress */}
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-medium">
              Session {completedSessions + 1}
            </div>
            {workEntities.map((we) => (
              <div key={we.id} className="text-xs text-zinc-400 truncate">
                <span className="text-zinc-300">{we.title}</span>
                {we.total > 0 && (
                  <span className="text-zinc-600 ml-1.5 tabular-nums">
                    {we.done}/{we.total}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Next Up */}
          {nextUp && (
            <div className="pt-1 border-t border-zinc-800/40">
              <div className="text-[10px] text-zinc-600">
                Next:{' '}
                <span className="text-zinc-500">{nextUp.title}</span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="px-3 py-3 text-[10px] text-zinc-600 text-center">
          {phase === 'idle' ? 'Start a session' : 'On break'}
        </div>
      )}
    </div>
  )
}
