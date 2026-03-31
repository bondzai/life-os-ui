import { useMemo, useCallback } from 'react'
import { Repeat, Flame } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import type { Entity } from '@/core/types'

interface ProtocolStep {
  id: string
  label: string
  order: number
}

function getCompletedSteps(trackerNote: string | undefined | null): string[] {
  if (!trackerNote) return []
  try {
    const parsed = JSON.parse(trackerNote)
    if (Array.isArray(parsed)) return parsed
  } catch { /* */ }
  return []
}

function getSteps(habit: Entity): ProtocolStep[] {
  if (Array.isArray(habit.metadata.steps) && (habit.metadata.steps as ProtocolStep[]).length > 0) {
    return (habit.metadata.steps as ProtocolStep[]).sort((a, b) => a.order - b.order)
  }
  return [{ id: 'legacy-complete', label: habit.title, order: 0 }]
}

function getTodayStart(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export function HabitStrip() {
  const { items: allHabits, update } = useEntities('habit')
  const { items: allTrackers, create: createTracker, update: updateTracker, remove: removeTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)

  const todayStart = useMemo(() => getTodayStart(), [])
  const activeHabits = useMemo(
    () => allHabits.filter((h) => h.status === 'todo'),
    [allHabits],
  )

  const getTodayTracker = useCallback(
    (habitId: string) =>
      allTrackers.find((t) => t.entityId === habitId && t.timestamp >= todayStart),
    [allTrackers, todayStart],
  )

  const handleToggleStep = useCallback(
    (habit: Entity, stepId: string, completed: boolean) => {
      const existing = getTodayTracker(habit.id)
      const currentSteps = getCompletedSteps(existing?.note)
      const steps = getSteps(habit)
      const totalSteps = steps.length

      let newSteps: string[]
      if (completed) {
        newSteps = [...new Set([...currentSteps, stepId])]
      } else {
        newSteps = currentSteps.filter((s) => s !== stepId)
      }

      const allDone = newSteps.length >= totalSteps
      const wasDone = currentSteps.length >= totalSteps

      if (existing) {
        if (newSteps.length === 0) {
          removeTracker.mutate(existing.id)
        } else {
          updateTracker.mutate({ id: existing.id, updates: { note: JSON.stringify(newSteps) } })
        }
      } else if (newSteps.length > 0) {
        createTracker.mutate({
          id: crypto.randomUUID(),
          entityId: habit.id,
          value: 1,
          unit: 'done',
          note: JSON.stringify(newSteps),
          timestamp: new Date().toISOString(),
          ownerId: currentUser?.id ?? '',
        })
      }

      if (allDone && !wasDone) {
        const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0
        update.mutate({
          id: habit.id,
          updates: { metadata: { ...habit.metadata, streak: streak + 1 }, updatedAt: new Date().toISOString() },
        })
      } else if (!allDone && wasDone) {
        const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0
        update.mutate({
          id: habit.id,
          updates: { metadata: { ...habit.metadata, streak: Math.max(0, streak - 1) }, updatedAt: new Date().toISOString() },
        })
      }
    },
    [getTodayTracker, createTracker, updateTracker, removeTracker, update, currentUser],
  )

  if (activeHabits.length === 0) return null

  const totalDone = activeHabits.filter((h) => {
    const tracker = getTodayTracker(h.id)
    const steps = getSteps(h)
    const completed = getCompletedSteps(tracker?.note)
    return completed.length >= steps.length
  }).length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1.5">
          <Repeat className="h-3 w-3" />
          Systems
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/50">
          {totalDone}/{activeHabits.length}
        </span>
      </div>

      <div className="space-y-2">
        {activeHabits.map((habit) => {
          const tracker = getTodayTracker(habit.id)
          const completedSteps = getCompletedSteps(tracker?.note)
          const steps = getSteps(habit)
          const doneCount = completedSteps.filter((id) => steps.some((s) => s.id === id)).length
          const allDone = steps.length > 0 && doneCount >= steps.length
          const pct = steps.length > 0 ? Math.round((doneCount / steps.length) * 100) : 0
          const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0

          return (
            <div
              key={habit.id}
              className={`rounded-lg border p-3 space-y-2 transition-colors ${
                allDone ? 'border-green-500/50 bg-green-50/30 dark:bg-green-950/10' : 'bg-card/50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium truncate">{habit.title}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {streak > 0 && (
                    <span className="flex items-center gap-0.5 text-[10px] text-orange-500/70">
                      <Flame className="h-3 w-3" />{streak}
                    </span>
                  )}
                  <span className={`text-[10px] tabular-nums ${allDone ? 'text-green-600' : 'text-muted-foreground/50'}`}>
                    {doneCount}/{steps.length}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {steps.map((step) => {
                  const isDone = completedSteps.includes(step.id)
                  return (
                    <label key={step.id} className="flex items-center gap-1.5 py-0.5 cursor-pointer">
                      <Checkbox
                        checked={isDone}
                        onCheckedChange={(checked) => handleToggleStep(habit, step.id, !!checked)}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span className={`text-xs ${isDone ? 'line-through text-muted-foreground' : ''}`}>
                        {step.label}
                      </span>
                    </label>
                  )
                })}
              </div>
              <Progress value={pct} className="h-1" />
            </div>
          )
        })}
      </div>
    </div>
  )
}
