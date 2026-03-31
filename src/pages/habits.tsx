import { useState, useMemo, useCallback } from 'react'
import { Plus, Repeat, Pencil, Trash2, Flame, ListChecks } from 'lucide-react'
import { ViewToggle, getStoredView, storeView, type ViewMode } from '@/components/view-toggle'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { PriorityBadge } from '@/core/components/priority-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import { AIAction } from '@/components/ai-action'
import { HabitHeatmap } from './habits/habit-heatmap'
import { ProtocolDialog, type ProtocolStep } from './habits/protocol-dialog'
import type { Entity, EntityStatus } from '@/core/types'

function getTodayStart(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
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
  // Legacy habit without steps — create a single "Complete" step
  return [{ id: 'legacy-complete', label: habit.title, order: 0 }]
}

export function HabitsPage() {
  const { items: allHabits, isLoading, create, update, remove } = useEntities('habit')
  const { items: allTrackers, create: createTracker, update: updateTracker, remove: removeTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [viewMode, setViewMode] = useState<ViewMode>(() => getStoredView('habits'))
  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingHabit, setEditingHabit] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const handleViewChange = (mode: ViewMode) => {
    setViewMode(mode)
    storeView('habits', mode)
  }

  const habits = useMemo(() => {
    let filtered = allHabits
    if (statusFilter !== 'all') {
      filtered = filtered.filter((h) => h.status === statusFilter)
    }
    return filtered
  }, [allHabits, statusFilter])

  const todayStart = useMemo(() => getTodayStart(), [])

  const getTodayTracker = useCallback(
    (habitId: string) =>
      allTrackers.find(
        (t) => t.entityId === habitId && t.timestamp >= todayStart,
      ),
    [allTrackers, todayStart],
  )

  // Step toggle — works for all habits (protocol or legacy)
  const handleToggleStep = (habit: Entity, stepId: string, completed: boolean) => {
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
        updateTracker.mutate({
          id: existing.id,
          updates: { note: JSON.stringify(newSteps) },
        })
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
        updates: {
          metadata: { ...habit.metadata, streak: streak + 1 },
          updatedAt: new Date().toISOString(),
        },
      })
    } else if (!allDone && wasDone) {
      const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0
      update.mutate({
        id: habit.id,
        updates: {
          metadata: { ...habit.metadata, streak: Math.max(0, streak - 1) },
          updatedAt: new Date().toISOString(),
        },
      })
    }
  }

  // Create
  const handleCreate = (values: { title: string; description: string; steps: ProtocolStep[] }) => {
    create.mutate({
      id: crypto.randomUUID(),
      type: 'habit',
      title: values.title,
      description: values.description || undefined,
      status: 'todo',
      priority: 'medium',
      tags: [],
      metadata: {
        streak: 0,
        frequency: 'daily',
        steps: values.steps,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Habit created', type: 'success' })
  }

  // Edit
  const handleEdit = (values: { title: string; description: string; steps: ProtocolStep[] }) => {
    if (!editingHabit) return
    update.mutate({
      id: editingHabit.id,
      updates: {
        title: values.title,
        description: values.description || undefined,
        metadata: { ...editingHabit.metadata, steps: values.steps },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Habit updated', type: 'success' })
    setEditingHabit(null)
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as EntityStatus | 'all')}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="todo">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <ViewToggle value={viewMode} onChange={handleViewChange} />
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Habit
          </Button>
        </div>
      </div>

      {/* Content */}
      {habits.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="No habits yet"
          description="Create a habit with steps to build systems, not checkboxes."
          actionLabel="New Habit"
          onAction={() => setDialogOpen(true)}
        />
      ) : viewMode === 'grid' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {habits.map((habit) => {
            const tracker = getTodayTracker(habit.id)
            const completedSteps = getCompletedSteps(tracker?.note)
            const steps = getSteps(habit)
            const totalSteps = steps.length
            const doneCount = completedSteps.filter((id) => steps.some((s) => s.id === id)).length
            const allDone = totalSteps > 0 && doneCount >= totalSteps
            const pct = totalSteps > 0 ? Math.round((doneCount / totalSteps) * 100) : 0
            const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0

            return (
              <div
                key={habit.id}
                className={`rounded-lg border p-4 space-y-3 transition-colors ${
                  allDone ? 'border-green-500/50 bg-green-50/30 dark:bg-green-950/10' : 'bg-card'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <ListChecks className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium truncate">{habit.title}</span>
                  </div>
                  <PriorityBadge priority={habit.priority} />
                </div>

                {habit.description && (
                  <p className="text-xs text-muted-foreground line-clamp-1">{habit.description}</p>
                )}

                {/* Steps */}
                <div className="space-y-1.5">
                  {steps.map((step) => {
                    const isDone = completedSteps.includes(step.id)
                    return (
                      <label
                        key={step.id}
                        className={`flex items-center gap-2.5 py-1 px-2 rounded-md cursor-pointer transition-colors hover:bg-accent/50 ${
                          isDone ? 'bg-accent/30' : ''
                        }`}
                      >
                        <Checkbox
                          checked={isDone}
                          onCheckedChange={(checked) => handleToggleStep(habit, step.id, !!checked)}
                          className="shrink-0"
                        />
                        <span className={`text-sm ${isDone ? 'line-through text-muted-foreground' : ''}`}>
                          {step.label}
                        </span>
                      </label>
                    )
                  })}
                </div>

                {/* Progress */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{doneCount}/{totalSteps}</span>
                    <span className={pct === 100 ? 'text-green-600 font-medium' : 'text-muted-foreground'}>{pct}%</span>
                  </div>
                  <Progress value={pct} className="h-1.5" />
                </div>

                {/* Streak */}
                <div className="flex items-center gap-1.5">
                  <Flame className="h-4 w-4 text-orange-500" />
                  <span className="text-sm font-medium">{streak}</span>
                  <span className="text-xs text-muted-foreground">day streak</span>
                  {streak >= 90 && <Badge className="text-xs bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">90d</Badge>}
                  {streak >= 30 && streak < 90 && <Badge className="text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300">30d</Badge>}
                  {streak >= 7 && streak < 30 && <Badge className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">7d</Badge>}
                </div>

                {/* Heatmap */}
                <HabitHeatmap trackers={allTrackers} habitId={habit.id} />

                {/* Actions */}
                <div className="flex gap-1 pt-1">
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingHabit(habit)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setDeleteTarget(habit)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  <AIAction tool="coaching" entityId={habit.id} label="Coach me" compact />
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        /* List view */
        <div className="rounded-lg border divide-y">
          {habits.map((habit) => {
            const tracker = getTodayTracker(habit.id)
            const completedSteps = getCompletedSteps(tracker?.note)
            const steps = getSteps(habit)
            const totalSteps = steps.length
            const doneCount = completedSteps.filter((id) => steps.some((s) => s.id === id)).length
            const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0

            return (
              <div key={habit.id} className="flex items-center gap-3 px-4 py-3 group">
                <ListChecks className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium flex-1 min-w-0 truncate">{habit.title}</span>
                <Badge variant="outline" className="text-xs shrink-0">{totalSteps} steps</Badge>
                <Badge variant={doneCount >= totalSteps ? 'default' : 'outline'} className="text-xs shrink-0">
                  {doneCount}/{totalSteps}
                </Badge>
                <div className="flex items-center gap-1 shrink-0">
                  <Flame className="h-3.5 w-3.5 text-orange-500" />
                  <span className="text-xs font-medium">{streak}</span>
                </div>
                <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingHabit(habit)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setDeleteTarget(habit)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Create dialog — always protocol */}
      <ProtocolDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="New Habit"
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <ProtocolDialog
        open={!!editingHabit}
        onOpenChange={(open) => !open && setEditingHabit(null)}
        title="Edit Habit"
        defaultValues={editingHabit ? {
          title: editingHabit.title,
          description: editingHabit.description || '',
          steps: getSteps(editingHabit),
        } : undefined}
        onSubmit={handleEdit}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Habit"
        description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate(deleteTarget.id)
            notify({ title: 'Habit deleted', type: 'success' })
            setDeleteTarget(null)
          }
        }}
      />
    </div>
  )
}
