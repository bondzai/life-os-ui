import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { X, Play, Pause, SkipForward, Square, Timer, Flame } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { useFocusStore } from '@/stores/focus-store'
import type { Entity } from '@/core/types'

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

export function DeepWorkPage() {
  const navigate = useNavigate()
  const {
    activeEntityId,
    phase,
    currentSession,
    completedSessions,
    settings,
    preset,
    startSession,
    completeWorkSession,
    completeBreak,
    endDeepWork,
    setPhase,
    setPreset,
  } = useFocusStore()
  const { items: allEntities, update } = useEntities()
  const { items: allTrackers, create: createTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)

  const entity = allEntities.find((e) => e.id === activeEntityId)
  const subtasks = useMemo(
    () =>
      Array.isArray(entity?.metadata.subtasks)
        ? (entity.metadata.subtasks as Array<{ id: string; title: string; done: boolean }>)
        : [],
    [entity],
  )

  // Timer state
  const [secondsLeft, setSecondsLeft] = useState(() => settings.workMinutes * 60)
  const [isRunning, setIsRunning] = useState(false)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  // Total duration for progress calculation
  const totalDuration = useMemo(() => {
    if (phase === 'work') return settings.workMinutes * 60
    if (phase === 'break') return settings.breakMinutes * 60
    if (phase === 'long-break') return settings.longBreakMinutes * 60
    return settings.workMinutes * 60
  }, [phase, settings])

  // Reset timer when phase changes
  useEffect(() => {
    if (phase === 'work') setSecondsLeft(settings.workMinutes * 60)
    else if (phase === 'break') setSecondsLeft(settings.breakMinutes * 60)
    else if (phase === 'long-break') setSecondsLeft(settings.longBreakMinutes * 60)

    setIsRunning(phase === 'work' || phase === 'break' || phase === 'long-break')
  }, [phase, settings])

  // Sound notification — reuse AudioContext to avoid repeated allocations
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

  // Log focus session as tracker
  const logSession = useCallback(() => {
    if (!activeEntityId) return
    createTracker.mutate({
      id: crypto.randomUUID(),
      entityId: activeEntityId,
      value: settings.workMinutes,
      unit: 'focus-min',
      timestamp: new Date().toISOString(),
      ownerId: currentUser?.id ?? '',
    })
  }, [activeEntityId, settings.workMinutes, createTracker, currentUser])

  // Keep timer-end callback in a ref so the interval never restarts due to dependency changes
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

  // Stable interval that reads from ref — only depends on isRunning
  useEffect(() => {
    if (!isRunning || secondsLeft <= 0) return
    const interval = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval)
          handleTimerEndRef.current()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [isRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  // Esc key to exit
  const handleExit = useCallback(() => {
    endDeepWork()
    navigate(-1)
  }, [endDeepWork, navigate])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleExit()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleExit])

  // Toggle subtask
  const toggleSubtask = useCallback(
    (subtaskId: string) => {
      if (!entity) return
      const updated = subtasks.map((s) => (s.id === subtaskId ? { ...s, done: !s.done } : s))
      const allDone = updated.length > 0 && updated.every((s) => s.done)
      update.mutate({
        id: entity.id,
        updates: {
          metadata: { ...entity.metadata, subtasks: updated },
          status: allDone ? 'completed' : 'active',
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [entity, subtasks, update],
  )

  // Daily focus total
  const todayFocusMinutes = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0]
    return allTrackers
      .filter((t) => t.unit === 'focus-min' && t.timestamp.startsWith(todayStr))
      .reduce((sum, t) => sum + t.value, 0)
  }, [allTrackers])

  // Timer controls
  const handlePause = () => setIsRunning(false)
  const handleResume = () => setIsRunning(true)
  const handleSkip = () => handleTimerEndRef.current()
  const handleStartWork = () => setPhase('work')

  // Find first incomplete subtask index
  const currentSubtaskIndex = subtasks.findIndex((s) => !s.done)

  // Progress percentage
  const timerProgress = totalDuration > 0 ? ((totalDuration - secondsLeft) / totalDuration) * 100 : 0

  // Phase label
  const phaseLabel = phase === 'work' ? 'Focus' : phase === 'break' ? 'Break' : phase === 'long-break' ? 'Long Break' : 'Ready'
  const phaseColor =
    phase === 'work'
      ? 'text-orange-500'
      : phase === 'break'
        ? 'text-green-500'
        : phase === 'long-break'
          ? 'text-blue-500'
          : 'text-muted-foreground'

  // ─── Task Picker (no entity selected) ───
  if (!entity) {
    const candidates = allEntities.filter(
      (e: Entity) => (e.type === 'task' || e.type === 'goal') && e.status === 'active',
    )
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-full max-w-md space-y-4 p-4">
          <div className="text-center space-y-2">
            <Timer className="h-8 w-8 mx-auto text-primary/60" />
            <h2 className="text-xl font-semibold">What will you focus on?</h2>
            <p className="text-sm text-muted-foreground">Pick a task to start your deep work session</p>
          </div>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {candidates.map((item) => (
              <button
                key={item.id}
                onClick={() => startSession(item.id)}
                className="w-full text-left p-3 rounded-lg border hover:bg-muted/50 transition-colors"
              >
                <p className="text-sm font-medium">{item.title}</p>
                {Array.isArray(item.metadata.subtasks) && (
                  <p className="text-xs text-muted-foreground">
                    {(item.metadata.subtasks as Array<{ done: boolean }>).filter((s) => !s.done).length} steps remaining
                  </p>
                )}
              </button>
            ))}
            {candidates.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">No active tasks or goals found</p>
            )}
          </div>
          <div className="text-center">
            <button
              onClick={() => navigate(-1)}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ─── Main Deep Work UI ───
  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Top bar */}
      <div className="flex items-center justify-between p-4">
        <button
          onClick={handleExit}
          className="p-2 rounded-lg hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
          title="Exit (Esc)"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className={phaseColor}>{phaseLabel}</span>
          <span className="text-muted-foreground/40">|</span>
          <span className="tabular-nums">
            Session {currentSession}/{settings.sessionsBeforeLongBreak}
          </span>
        </div>
      </div>

      {/* Main content — centered */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 max-w-2xl mx-auto w-full gap-8">
        {/* Task title */}
        <div className="text-center space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{entity.title}</h1>
          {completedSessions > 0 && (
            <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
              <Flame className="h-3 w-3 text-orange-500" />
              {completedSessions} session{completedSessions !== 1 ? 's' : ''} completed
            </p>
          )}
        </div>

        {/* Subtask checklist */}
        {subtasks.length > 0 && (
          <div className="w-full max-w-sm space-y-1">
            {subtasks.map((sub, i) => {
              const isCurrent = i === currentSubtaskIndex
              return (
                <label
                  key={sub.id}
                  className={`flex items-center gap-3 py-1.5 px-3 rounded-lg cursor-pointer transition-colors ${
                    isCurrent
                      ? 'bg-primary/5 border border-primary/20'
                      : sub.done
                        ? 'opacity-50'
                        : 'hover:bg-muted/30'
                  }`}
                >
                  <Checkbox
                    checked={sub.done}
                    onCheckedChange={() => toggleSubtask(sub.id)}
                    className="h-4 w-4 shrink-0"
                  />
                  {isCurrent && <span className="text-primary text-xs shrink-0">&rarr;</span>}
                  <span
                    className={`text-sm ${
                      sub.done
                        ? 'line-through text-muted-foreground'
                        : isCurrent
                          ? 'font-medium text-foreground'
                          : 'text-muted-foreground'
                    }`}
                  >
                    {sub.title}
                  </span>
                </label>
              )
            })}
          </div>
        )}

        {/* Timer */}
        <div className="flex flex-col items-center gap-4">
          <div className="text-6xl font-mono tabular-nums tracking-tight select-none">{formatTime(secondsLeft)}</div>
          <Progress value={timerProgress} className="h-2 w-64" />
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {phase === 'idle' ? (
            <Button onClick={handleStartWork} size="lg" className="gap-2">
              <Play className="h-4 w-4" />
              Start Focus
            </Button>
          ) : (
            <>
              {isRunning ? (
                <Button onClick={handlePause} variant="outline" size="lg" className="gap-2">
                  <Pause className="h-4 w-4" />
                  Pause
                </Button>
              ) : (
                <Button onClick={handleResume} size="lg" className="gap-2">
                  <Play className="h-4 w-4" />
                  Resume
                </Button>
              )}
              <Button onClick={handleSkip} variant="outline" size="lg" className="gap-2">
                <SkipForward className="h-4 w-4" />
                Skip
              </Button>
              <Button onClick={handleExit} variant="ghost" size="lg" className="gap-2 text-muted-foreground">
                <Square className="h-4 w-4" />
                End
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-center gap-6 p-4 text-sm text-muted-foreground border-t border-border/50">
        <div className="flex items-center gap-2">
          <span className="text-xs">Preset:</span>
          <Select value={preset} onValueChange={(v) => setPreset(v as 'classic' | 'deep' | 'sprint')}>
            <SelectTrigger className="h-7 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="classic">Classic (25m)</SelectItem>
              <SelectItem value="deep">Deep (50m)</SelectItem>
              <SelectItem value="sprint">Sprint (90m)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <span className="text-muted-foreground/30">|</span>
        <span className="text-xs tabular-nums">
          {completedSessions} session{completedSessions !== 1 ? 's' : ''}
        </span>
        <span className="text-muted-foreground/30">|</span>
        <span className="text-xs tabular-nums flex items-center gap-1">
          <Timer className="h-3 w-3" />
          {formatMinutes(todayFocusMinutes)} today
        </span>
      </div>
    </div>
  )
}
