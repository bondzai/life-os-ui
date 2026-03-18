import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { X, Play, Pause, SkipForward, Square, Timer, Flame, Crown, ChevronRight, Plus, CheckCircle2, ChevronDown, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { useFocusStore } from '@/stores/focus-store'
import type { Entity, Tracker } from '@/core/types'

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

type SubtaskStatus = 'todo' | 'in-progress' | 'done'
type Subtask = { id: string; title: string; done: boolean; status?: SubtaskStatus }

function stStatus(s: Subtask): SubtaskStatus {
  if (s.status) return s.status
  return s.done ? 'done' : 'todo'
}
function stDone(s: Subtask): boolean {
  return stStatus(s) === 'done'
}

/* Phase-based color tokens */
const PHASE_STYLES = {
  idle: {
    bg: 'bg-[#0a0a0f]',
    timerColor: 'text-zinc-400',
    accent: 'text-zinc-500',
    ring: 'from-zinc-800 to-zinc-900',
    trackBg: 'bg-zinc-800/50',
    trackFill: 'bg-zinc-600',
  },
  work: {
    bg: 'bg-[#0a0a0f]',
    timerColor: 'text-amber-400',
    accent: 'text-amber-500',
    ring: 'from-amber-900/40 to-orange-900/20',
    trackBg: 'bg-amber-950/30',
    trackFill: 'bg-amber-500',
  },
  break: {
    bg: 'bg-[#060f0a]',
    timerColor: 'text-emerald-400',
    accent: 'text-emerald-500',
    ring: 'from-emerald-900/30 to-green-900/15',
    trackBg: 'bg-emerald-950/30',
    trackFill: 'bg-emerald-500',
  },
  'long-break': {
    bg: 'bg-[#060a12]',
    timerColor: 'text-sky-400',
    accent: 'text-sky-500',
    ring: 'from-sky-900/30 to-blue-900/15',
    trackBg: 'bg-sky-950/30',
    trackFill: 'bg-sky-500',
  },
} as const

function QuickAddSubtask({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex items-center gap-2 pt-1.5 px-3">
      <Plus className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
      <input
        className="flex-1 text-sm bg-transparent border-0 border-b border-dashed border-zinc-800 px-0 py-1 focus:outline-none focus:border-amber-500/50 placeholder:text-zinc-700 text-zinc-300"
        placeholder="Add subtask..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) {
            onAdd(value.trim())
            setValue('')
          }
        }}
      />
    </div>
  )
}

/* ─── Session Log Entry ─── */

interface ParsedNote {
  sessionId?: string
  task: string
  completed: string[]
  progress?: string
}

function parseLogNote(raw?: string | null): ParsedNote | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw)
    if (typeof p === 'object' && p.task) return p as ParsedNote
  } catch { /* ignore */ }
  return null
}

function SessionLogEntry({ tracker, entityTitle, onUpdate, onDelete }: {
  tracker: Tracker
  entityTitle: string
  onUpdate: (id: string, note: string) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const parsed = parseLogNote(tracker.note)
  const [editCompleted, setEditCompleted] = useState<string[]>(parsed?.completed ?? [])
  const [newItem, setNewItem] = useState('')

  const time = new Date(tracker.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const handleSave = () => {
    const updated: ParsedNote = {
      ...(parsed ?? { task: entityTitle, completed: [] }),
      completed: editCompleted.filter((c) => c.trim()),
    }
    onUpdate(tracker.id, JSON.stringify(updated))
    setEditing(false)
  }

  const handleAddItem = () => {
    if (!newItem.trim()) return
    setEditCompleted([...editCompleted, newItem.trim()])
    setNewItem('')
  }

  const handleRemoveItem = (idx: number) => {
    setEditCompleted(editCompleted.filter((_, i) => i !== idx))
  }

  if (editing) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 tabular-nums shrink-0">{time}</span>
          <span className="text-sm text-zinc-200 font-medium truncate flex-1">{entityTitle}</span>
          <span className="text-xs text-zinc-500 tabular-nums">{tracker.value}m</span>
        </div>

        <div className="space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">What was done</span>
          {editCompleted.map((item, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <CheckCircle2 className="h-3 w-3 text-green-500/60 shrink-0" />
              <span className="text-xs text-zinc-300 flex-1">{item}</span>
              <button onClick={() => handleRemoveItem(i)} className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-600 hover:text-red-400">
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Plus className="h-3 w-3 text-zinc-600 shrink-0" />
            <input
              className="flex-1 text-xs bg-transparent border-0 border-b border-dashed border-zinc-800 px-0 py-1 focus:outline-none focus:border-amber-500/50 placeholder:text-zinc-700 text-zinc-300"
              placeholder="Add completed item..."
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddItem() }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button onClick={handleSave} className="text-[10px] font-medium px-2.5 py-1 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors">
            Save
          </button>
          <button onClick={() => { setEditing(false); setEditCompleted(parsed?.completed ?? []) }} className="text-[10px] font-medium px-2.5 py-1 rounded text-zinc-500 hover:text-zinc-300 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-2 py-1.5 group">
      <div className="w-1.5 h-1.5 rounded-full bg-amber-500/40 mt-1.5 shrink-0" />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">{time}</span>
          <span className="text-sm text-zinc-300 truncate flex-1">{entityTitle}</span>
          <span className="text-xs text-zinc-500 tabular-nums shrink-0">{tracker.value}m</span>
          {parsed?.progress && (
            <span className="text-[9px] text-zinc-600 tabular-nums shrink-0">{parsed.progress}</span>
          )}
          <button
            onClick={() => setEditing(true)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-600 hover:text-amber-400"
            title="Edit log"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={() => onDelete(tracker.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-600 hover:text-red-400"
            title="Delete log"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
        {parsed?.completed && parsed.completed.length > 0 && (
          <div className="space-y-0.5 ml-6">
            {parsed.completed.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-2.5 w-2.5 text-green-500/60 shrink-0" />
                <span className="text-[11px] text-zinc-400">{item}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Session History Panel ─── */

function SessionHistoryPanel({ sessionId, trackers, entityTitles, onUpdate, onDelete }: {
  sessionId: string | null
  trackers: Tracker[]
  entityTitles: Map<string, string>
  onUpdate: (id: string, note: string) => void
  onDelete: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(true)

  const sessionTrackers = useMemo(() => {
    if (!sessionId) return []
    return trackers
      .filter((t) => {
        if (t.unit !== 'focus-min') return false
        const note = parseLogNote(t.note)
        return note?.sessionId === sessionId
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }, [trackers, sessionId])

  const totalMinutes = useMemo(() => sessionTrackers.reduce((sum, t) => sum + t.value, 0), [sessionTrackers])

  if (sessionTrackers.length === 0) return null

  return (
    <div className="w-full rounded-xl border border-zinc-800/50 bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
      >
        <ChevronDown className={`h-3.5 w-3.5 text-zinc-600 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <Crown className="h-3 w-3 text-amber-500/50" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 flex-1">
          Session Log
        </span>
        <span className="text-[10px] text-zinc-600 tabular-nums">
          {sessionTrackers.length} pomodoro{sessionTrackers.length !== 1 ? 's' : ''}
        </span>
        <span className="text-xs font-medium text-amber-500/70 tabular-nums">{formatMinutes(totalMinutes)}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-0.5">
          {sessionTrackers.map((t) => (
            <SessionLogEntry
              key={t.id}
              tracker={t}
              entityTitle={entityTitles.get(t.entityId) || 'Unknown'}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function DeepWorkPage() {
  const navigate = useNavigate()
  const {
    activeEntityId,
    emperorEntityIds,
    sessionId,
    phase,
    currentSession,
    completedSessions,
    secondsLeft,
    isRunning,
    settings,
    preset,
    tick,
    pauseTimer,
    resumeTimer,
    completeWorkSession,
    completeBreak,
    endDeepWork,
    setPhase,
    setPreset,
  } = useFocusStore()
  const { items: allEntities, update } = useEntities()
  const { items: allTrackers, create: createTracker, update: updateTracker, remove: removeTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)

  const entityTitles = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of allEntities) m.set(e.id, e.title)
    return m
  }, [allEntities])

  const handleUpdateLog = useCallback((id: string, note: string) => {
    updateTracker.mutate({ id, updates: { note } })
  }, [updateTracker])

  const handleDeleteLog = useCallback((id: string) => {
    removeTracker.mutate(id)
  }, [removeTracker])

  const emperorEntities = useMemo(
    () => emperorEntityIds.map((id) => allEntities.find((e) => e.id === id)).filter(Boolean) as Entity[],
    [emperorEntityIds, allEntities],
  )

  const entity = allEntities.find((e) => e.id === activeEntityId)
  const subtasks = useMemo(
    () =>
      Array.isArray(entity?.metadata.subtasks)
        ? (entity.metadata.subtasks as Subtask[])
        : [],
    [entity],
  )

  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const totalDuration = useMemo(() => {
    if (phase === 'work') return settings.workMinutes * 60
    if (phase === 'break') return settings.breakMinutes * 60
    if (phase === 'long-break') return settings.longBreakMinutes * 60
    return settings.workMinutes * 60
  }, [phase, settings])

  // Sound
  const audioCtxRef = useRef<AudioContext | null>(null)
  const playChime = useCallback(() => {
    if (!settings.soundEnabled) return
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      const ctx = audioCtxRef.current
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = 800
      gain.gain.value = 0.3
      osc.start()
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8)
      osc.stop(ctx.currentTime + 0.8)
    } catch {
      // Audio not available
    }
  }, [settings.soundEnabled])

  // Track subtask state at session start to compute what was done
  const sessionStartSubtasksRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (phase === 'work' && entity) {
      const doneBefore = new Set(
        (Array.isArray(entity.metadata.subtasks) ? (entity.metadata.subtasks as Subtask[]) : [])
          .filter((s) => stDone(s)).map((s) => s.id),
      )
      sessionStartSubtasksRef.current = doneBefore
    }
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // Log focus session with what was accomplished
  const logSession = useCallback(() => {
    if (!activeEntityId) return
    const currentEntity = allEntities.find((e) => e.id === activeEntityId)
    const subs = Array.isArray(currentEntity?.metadata.subtasks) ? (currentEntity.metadata.subtasks as Subtask[]) : []
    const doneNow = subs.filter((s) => stDone(s))
    const completedThisSession = doneNow.filter((s) => !sessionStartSubtasksRef.current.has(s.id))
    const note = JSON.stringify({
      sessionId: sessionId ?? undefined,
      task: currentEntity?.title ?? '',
      completed: completedThisSession.map((s) => s.title),
      progress: subs.length > 0 ? `${doneNow.length}/${subs.length}` : undefined,
      preset,
      workMinutes: settings.workMinutes,
      pomodoroIndex: completedSessions + 1,
      workspace: (currentEntity?.metadata?.workspace as string) ?? null,
    })
    createTracker.mutate({
      id: crypto.randomUUID(),
      entityId: activeEntityId,
      value: settings.workMinutes,
      unit: 'focus-min',
      note,
      timestamp: new Date().toISOString(),
      ownerId: currentUser?.id ?? '',
    })
  }, [activeEntityId, allEntities, settings.workMinutes, createTracker, currentUser, sessionId, preset, completedSessions])

  const handleTimerEndRef = useRef<() => void>(() => {})
  useEffect(() => {
    handleTimerEndRef.current = () => {
      playChime()
      if (phaseRef.current === 'work') {
        logSession()
        completeWorkSession()
      } else {
        completeBreak()
      }
    }
  })

  // Update browser tab title with countdown
  useEffect(() => {
    if (phase === 'idle') {
      document.title = 'Lyra \u2022 Emperor Time'
    } else {
      const label = phase === 'work' ? 'Focus' : phase === 'break' ? 'Break' : 'Rest'
      document.title = `${formatTime(secondsLeft)} \u2013 ${label}`
    }
    return () => { document.title = 'Lyra' }
  }, [secondsLeft, phase])

  useEffect(() => {
    if (!isRunning || secondsLeft <= 0) return
    const interval = setInterval(() => {
      const done = tick()
      if (done) {
        clearInterval(interval)
        handleTimerEndRef.current()
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [isRunning, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Navigate away — pause timer but keep session alive
  const handleLeave = useCallback(() => {
    pauseTimer()
    navigate(-1)
  }, [pauseTimer, navigate])

  // Explicitly end the session (stop button)
  const handleEnd = useCallback(() => {
    endDeepWork()
    navigate(-1)
  }, [endDeepWork, navigate])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleLeave()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleLeave])

  // Cycle subtask: todo → in-progress → done
  const toggleSubtask = useCallback(
    (subtaskId: string) => {
      if (!entity) return
      const updated = subtasks.map((s) => {
        if (s.id !== subtaskId) return s
        const current = stStatus(s)
        const next: SubtaskStatus = current === 'todo' ? 'in-progress' : current === 'in-progress' ? 'done' : 'todo'
        return { ...s, done: next === 'done', status: next }
      })
      const allDone = updated.length > 0 && updated.every((s) => stDone(s))
      const hasWip = updated.some((s) => stStatus(s) === 'in-progress')
      const hasDone = updated.some((s) => stDone(s))
      const derivedStatus = allDone ? 'done' : (hasWip || hasDone) ? 'in-progress' : entity.status
      update.mutate({
        id: entity.id,
        updates: {
          metadata: { ...entity.metadata, subtasks: updated },
          status: derivedStatus,
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [entity, subtasks, update],
  )

  // Add subtask to any entity
  const addSubtask = useCallback(
    (targetEntity: Entity, title: string) => {
      const existing = Array.isArray(targetEntity.metadata.subtasks)
        ? (targetEntity.metadata.subtasks as Subtask[])
        : []
      const newSub: Subtask = { id: crypto.randomUUID(), title, done: false, status: 'todo' }
      update.mutate({
        id: targetEntity.id,
        updates: {
          metadata: { ...targetEntity.metadata, subtasks: [...existing, newSub] },
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [update],
  )

  const todayFocusMinutes = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0]
    return allTrackers
      .filter((t) => t.unit === 'focus-min' && t.timestamp.startsWith(todayStr))
      .reduce((sum, t) => sum + t.value, 0)
  }, [allTrackers])

  const handlePause = () => pauseTimer()
  const handleResume = () => resumeTimer()
  const handleSkip = () => handleTimerEndRef.current()
  const handleStartWork = () => setPhase('work')

  const timerProgress = totalDuration > 0 ? ((totalDuration - secondsLeft) / totalDuration) * 100 : 0
  const phaseLabel = phase === 'work' ? 'Focus' : phase === 'break' ? 'Break' : phase === 'long-break' ? 'Long Break' : 'Ready'
  const style = PHASE_STYLES[phase]

  // No focus tasks
  if (emperorEntities.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0f]">
        <div className="text-center space-y-4">
          <Crown className="h-10 w-10 mx-auto text-amber-500/30" />
          <h2 className="text-lg font-semibold text-zinc-200">No focus tasks set</h2>
          <p className="text-sm text-zinc-500">Pick your focus for today first, then enter Emperor Time.</p>
          <Button variant="outline" onClick={() => navigate('/')} className="border-zinc-800 text-zinc-300 hover:bg-zinc-900">
            Back to Today
          </Button>
        </div>
      </div>
    )
  }

  // ─── Emperor Time ───
  return (
    <div className={`min-h-screen flex flex-col transition-colors duration-700 ${style.bg}`}>
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4">
        <button
          onClick={handleLeave}
          className="p-2 rounded-lg hover:bg-white/5 transition-colors text-zinc-600 hover:text-zinc-400"
          title="Leave (Esc) — session stays active"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs font-medium tracking-wider uppercase text-amber-500/70">
            <Crown className="h-3.5 w-3.5" />
            Emperor Time
          </span>
          <span className="w-px h-3 bg-zinc-800" />
          <span className={`text-xs font-medium ${style.accent}`}>{phaseLabel}</span>
          <span className="w-px h-3 bg-zinc-800" />
          <span className="text-xs text-zinc-600 tabular-nums">
            {currentSession}/{settings.sessionsBeforeLongBreak}
          </span>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-4 max-w-2xl mx-auto w-full gap-8">
        {/* Timer ring */}
        <div className="relative flex flex-col items-center gap-6">
          {/* Glow behind timer */}
          <div className={`absolute inset-0 -m-12 rounded-full bg-gradient-radial ${style.ring} blur-3xl opacity-60 pointer-events-none`} />

          <div className={`relative text-7xl font-light tabular-nums tracking-tight select-none ${style.timerColor}`}>
            {formatTime(secondsLeft)}
          </div>

          {/* Progress track */}
          <div className={`relative w-72 h-1 rounded-full ${style.trackBg} overflow-hidden`}>
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-all duration-1000 ease-linear ${style.trackFill}`}
              style={{ width: `${timerProgress}%` }}
            />
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {phase === 'idle' ? (
            <Button
              onClick={handleStartWork}
              size="lg"
              className="gap-2 bg-amber-500 hover:bg-amber-400 text-black font-medium rounded-full px-8"
            >
              <Play className="h-4 w-4" />
              Start Focus
            </Button>
          ) : (
            <>
              {isRunning ? (
                <button onClick={handlePause} className="h-12 w-12 rounded-full border border-zinc-700 flex items-center justify-center hover:bg-white/5 transition-colors text-zinc-400 hover:text-zinc-200">
                  <Pause className="h-5 w-5" />
                </button>
              ) : (
                <button onClick={handleResume} className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors ${phase === 'work' ? 'bg-amber-500 hover:bg-amber-400 text-black' : phase === 'break' ? 'bg-emerald-500 hover:bg-emerald-400 text-black' : 'bg-sky-500 hover:bg-sky-400 text-black'}`}>
                  <Play className="h-5 w-5" />
                </button>
              )}
              <button onClick={handleSkip} className="h-10 w-10 rounded-full border border-zinc-800 flex items-center justify-center hover:bg-white/5 transition-colors text-zinc-500 hover:text-zinc-300">
                <SkipForward className="h-4 w-4" />
              </button>
              <button onClick={handleEnd} className="h-10 w-10 rounded-full border border-red-900/50 flex items-center justify-center hover:bg-red-500/10 transition-colors text-red-500/60 hover:text-red-400" title="End session">
                <Square className="h-4 w-4" />
              </button>
            </>
          )}
        </div>

        {completedSessions > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Flame className="h-3.5 w-3.5 text-orange-500/70" />
            {completedSessions} session{completedSessions !== 1 ? 's' : ''}
          </div>
        )}

        {/* Focus tasks */}
        <div className="w-full space-y-2 mt-2">
          {emperorEntities.map((item) => {
            const subs = Array.isArray(item.metadata.subtasks) ? (item.metadata.subtasks as Subtask[]) : []
            const doneCount = subs.filter((s) => stDone(s)).length
            const inProgressCount = subs.filter((s) => stStatus(s) === 'in-progress').length
            const isActive = item.id === activeEntityId
            const allDone = item.status === 'done' || (subs.length > 0 && subs.every((s) => stDone(s)))

            return (
              <div
                key={item.id}
                className={`rounded-xl transition-all duration-300 ${
                  isActive
                    ? 'bg-white/[0.04] border border-zinc-700/50 shadow-lg shadow-black/20'
                    : allDone
                      ? 'bg-white/[0.01] border border-zinc-800/30 opacity-40'
                      : 'bg-white/[0.02] border border-zinc-800/40 hover:bg-white/[0.04] hover:border-zinc-700/50'
                }`}
              >
                {/* Story header */}
                <button
                  onClick={() => {
                    if (!allDone) useFocusStore.setState({ activeEntityId: item.id })
                  }}
                  className="flex items-center gap-3 w-full p-3.5 text-left"
                >
                  {isActive && <ChevronRight className="h-4 w-4 text-amber-500/70 shrink-0" />}
                  <span className={`text-sm font-medium flex-1 truncate ${allDone ? 'line-through text-zinc-600' : 'text-zinc-200'}`}>
                    {item.title}
                  </span>
                  {typeof item.metadata.workspace === 'string' && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${
                      item.metadata.workspace === 'work'
                        ? 'bg-blue-500/10 text-blue-400/70'
                        : 'bg-emerald-500/10 text-emerald-400/70'
                    }`}>
                      {item.metadata.workspace === 'work' ? 'Work' : 'Personal'}
                    </span>
                  )}
                  {subs.length > 0 && (
                    <span className={`text-xs tabular-nums shrink-0 ${allDone ? 'text-emerald-500/50' : 'text-zinc-500'}`}>
                      {doneCount}/{subs.length}
                      {inProgressCount > 0 && <span className="text-amber-500/60 ml-1">({inProgressCount} wip)</span>}
                    </span>
                  )}
                </button>

                {/* Subtasks + quick add */}
                {isActive && (
                  <div className="px-3.5 pb-3.5 space-y-0.5">
                    {subs.map((sub, i) => {
                      const st = stStatus(sub)
                      const isCurrent = st !== 'done' && i === subs.findIndex((s) => stStatus(s) !== 'done')
                      return (
                        <div
                          key={sub.id}
                          className={`flex items-center gap-3 py-1.5 px-3 rounded-lg transition-colors ${
                            isCurrent
                              ? 'bg-amber-500/[0.06] border border-amber-500/15'
                              : st === 'done'
                                ? 'opacity-40'
                                : st === 'in-progress'
                                  ? 'bg-amber-500/[0.03] border border-amber-500/10'
                                  : 'hover:bg-white/[0.03]'
                          }`}
                        >
                          {/* 3-state toggle: todo → in-progress → done */}
                          <button
                            onClick={() => toggleSubtask(sub.id)}
                            className={`h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors ${
                              st === 'done'
                                ? 'bg-emerald-600 border-emerald-600'
                                : st === 'in-progress'
                                  ? 'border-amber-500 bg-amber-500/20'
                                  : 'border-zinc-700'
                            }`}
                            title={`${st} — click to cycle`}
                          >
                            {st === 'done' && (
                              <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                            {st === 'in-progress' && (
                              <div className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                            )}
                          </button>

                          {st === 'in-progress' && <span className="text-[9px] font-medium text-amber-500/70 shrink-0">WIP</span>}
                          {isCurrent && st === 'todo' && <span className="text-amber-500/70 text-xs shrink-0">&rarr;</span>}
                          <span
                            className={`text-sm ${
                              st === 'done'
                                ? 'line-through text-zinc-600'
                                : st === 'in-progress'
                                  ? 'font-medium text-amber-300'
                                  : isCurrent
                                    ? 'font-medium text-zinc-200'
                                    : 'text-zinc-400'
                            }`}
                          >
                            {sub.title}
                          </span>
                        </div>
                      )
                    })}
                    <QuickAddSubtask onAdd={(title) => addSubtask(item, title)} />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Session history log */}
        <SessionHistoryPanel
          sessionId={sessionId}
          trackers={allTrackers}
          entityTitles={entityTitles}
          onUpdate={handleUpdateLog}
          onDelete={handleDeleteLog}
        />
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-center gap-6 px-6 py-4 border-t border-zinc-800/50">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600">Preset</span>
          <Select value={preset} onValueChange={(v) => setPreset(v as 'classic' | 'deep' | 'sprint')}>
            <SelectTrigger className="h-7 w-28 text-xs bg-transparent border-zinc-800 text-zinc-400 hover:border-zinc-700">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-zinc-800">
              <SelectItem value="classic">Classic (25m)</SelectItem>
              <SelectItem value="deep">Deep (50m)</SelectItem>
              <SelectItem value="sprint">Sprint (90m)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <span className="w-px h-3 bg-zinc-800" />
        <span className="text-xs text-zinc-600 tabular-nums">
          {completedSessions} session{completedSessions !== 1 ? 's' : ''}
        </span>
        <span className="w-px h-3 bg-zinc-800" />
        <span className="text-xs text-zinc-500 tabular-nums flex items-center gap-1.5">
          <Timer className="h-3 w-3 text-zinc-600" />
          {formatMinutes(todayFocusMinutes)} today
        </span>
      </div>
    </div>
  )
}
