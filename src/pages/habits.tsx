import { useState, useMemo, useCallback } from 'react'
import { Plus, Repeat, Pencil, Trash2, Flame, Check, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { StatusBadge } from '@/core/components/status-badge'
import { PriorityBadge } from '@/core/components/priority-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import { emitAutomationEvent } from './automate/automation-event-bus'
import { HabitHeatmap } from './habits/habit-heatmap'
import { ProtocolDialog, type ProtocolStep } from './habits/protocol-dialog'
import { ProtocolCard } from './habits/protocol-card'
import type { Entity, EntityStatus } from '@/core/types'

function getTodayStart(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function isProtocol(habit: Entity): boolean {
  return habit.metadata.isProtocol === true && Array.isArray(habit.metadata.steps)
}

function getCompletedSteps(trackerNote: string | undefined | null): string[] {
  if (!trackerNote) return []
  try {
    const parsed = JSON.parse(trackerNote)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // Not JSON
  }
  return []
}

export function HabitsPage() {
  const { items: allHabits, isLoading, create, update, remove } = useEntities('habit')
  const { items: allTrackers, create: createTracker, update: updateTracker, remove: removeTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [protocolDialogOpen, setProtocolDialogOpen] = useState(false)
  const [editingHabit, setEditingHabit] = useState<Entity | null>(null)
  const [editingProtocol, setEditingProtocol] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const habits = useMemo(() => {
    let filtered = allHabits
    if (statusFilter !== 'all') {
      filtered = filtered.filter((h) => h.status === statusFilter)
    }
    // Protocols first, then regular habits
    return [...filtered].sort((a, b) => {
      const aProto = isProtocol(a) ? 0 : 1
      const bProto = isProtocol(b) ? 0 : 1
      return aProto - bProto
    })
  }, [allHabits, statusFilter])

  const todayStart = useMemo(() => getTodayStart(), [])

  const getTodayTracker = useCallback(
    (habitId: string) =>
      allTrackers.find(
        (t) => t.entityId === habitId && t.timestamp >= todayStart,
      ),
    [allTrackers, todayStart],
  )

  // --- Regular Habit Check-in ---
  const handleCheckIn = (habit: Entity) => {
    const existing = getTodayTracker(habit.id)
    if (existing) {
      removeTracker.mutate(existing.id)
      const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0
      update.mutate({
        id: habit.id,
        updates: {
          metadata: { ...habit.metadata, streak: Math.max(0, streak - 1) },
          updatedAt: new Date().toISOString(),
        },
      })
    } else {
      createTracker.mutate({
        id: crypto.randomUUID(),
        entityId: habit.id,
        value: 1,
        unit: 'done',
        timestamp: new Date().toISOString(),
        ownerId: currentUser?.id ?? '',
      })
      const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0
      update.mutate({
        id: habit.id,
        updates: {
          metadata: { ...habit.metadata, streak: streak + 1 },
          updatedAt: new Date().toISOString(),
        },
      })
      emitAutomationEvent({ type: 'tracker-created', entityId: habit.id, entityType: 'habit' })
    }
  }

  // --- Protocol Step Toggle ---
  const handleToggleStep = (habit: Entity, stepId: string, completed: boolean) => {
    const existing = getTodayTracker(habit.id)
    const currentSteps = getCompletedSteps(existing?.note)
    const steps = (habit.metadata.steps as ProtocolStep[]) || []
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
      // Update existing tracker's note
      updateTracker.mutate({
        id: existing.id,
        updates: { note: JSON.stringify(newSteps) },
      })
    } else {
      // Create tracker with completed steps
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

    // Streak: increment when all steps done, decrement when undone from all-done
    if (allDone && !wasDone) {
      const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0
      update.mutate({
        id: habit.id,
        updates: {
          metadata: { ...habit.metadata, streak: streak + 1 },
          updatedAt: new Date().toISOString(),
        },
      })
      emitAutomationEvent({ type: 'tracker-created', entityId: habit.id, entityType: 'habit' })
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

  // --- Create Handlers ---
  const handleCreateHabit = (values: Record<string, unknown>) => {
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'habit',
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'active',
      priority: (values.priority as Entity['priority']) || 'medium',
      tags,
      metadata: { streak: 0, frequency: 'daily' },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Habit created', type: 'success' })
  }

  const handleCreateProtocol = (values: { title: string; description: string; steps: ProtocolStep[] }) => {
    create.mutate({
      id: crypto.randomUUID(),
      type: 'habit',
      title: values.title,
      description: values.description || undefined,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        streak: 0,
        frequency: 'daily',
        isProtocol: true,
        steps: values.steps,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Protocol created', type: 'success' })
  }

  const handleEditHabit = (values: Record<string, unknown>) => {
    if (!editingHabit) return
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    update.mutate({
      id: editingHabit.id,
      updates: {
        title: values.title as string,
        description: (values.description as string) || undefined,
        status: values.status as EntityStatus,
        priority: values.priority as Entity['priority'],
        tags,
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Habit updated', type: 'success' })
    setEditingHabit(null)
  }

  const handleEditProtocol = (values: { title: string; description: string; steps: ProtocolStep[] }) => {
    if (!editingProtocol) return
    update.mutate({
      id: editingProtocol.id,
      updates: {
        title: values.title,
        description: values.description || undefined,
        metadata: { ...editingProtocol.metadata, steps: values.steps },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Protocol updated', type: 'success' })
    setEditingProtocol(null)
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as EntityStatus | 'all')}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Filter status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Add dropdown: Habit or Protocol */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" /> New
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setDialogOpen(true)}>
              <Repeat className="h-4 w-4 mr-2" /> Habit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setProtocolDialogOpen(true)}>
              <ListChecks className="h-4 w-4 mr-2" /> Protocol
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Cards grid */}
      {habits.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="No habits yet"
          description="Create a habit or protocol to start building streaks."
          actionLabel="New Habit"
          onAction={() => setDialogOpen(true)}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {habits.map((habit) => {
            if (isProtocol(habit)) {
              const tracker = getTodayTracker(habit.id)
              const completedSteps = getCompletedSteps(tracker?.note)
              return (
                <ProtocolCard
                  key={habit.id}
                  habit={habit}
                  todayCompletedSteps={completedSteps}
                  onToggleStep={handleToggleStep}
                  onEdit={(h) => setEditingProtocol(h)}
                  onDelete={(h) => setDeleteTarget(h)}
                />
              )
            }

            // Regular habit card
            const checked = !!getTodayTracker(habit.id)
            const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0
            const frequency = typeof habit.metadata.frequency === 'string' ? habit.metadata.frequency : 'daily'

            return (
              <Card key={habit.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-sm font-medium">{habit.title}</CardTitle>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Badge variant="outline" className="text-xs capitalize">{frequency}</Badge>
                      <PriorityBadge priority={habit.priority} />
                      <StatusBadge status={habit.status} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {habit.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{habit.description}</p>
                  )}

                  {/* Streak + milestones */}
                  <div className="flex items-center gap-1.5">
                    <Flame className="h-4 w-4 text-orange-500" />
                    <span className="text-sm font-medium">{streak}</span>
                    <span className="text-xs text-muted-foreground">day streak</span>
                    {streak >= 90 && <Badge className="text-xs bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">90d</Badge>}
                    {streak >= 30 && streak < 90 && <Badge className="text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300">30d</Badge>}
                    {streak >= 7 && streak < 30 && <Badge className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">7d</Badge>}
                  </div>

                  {/* Monthly completion rate */}
                  {(() => {
                    const now = new Date()
                    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
                    const monthStartISO = monthStart.toISOString()
                    const daysElapsed = now.getDate()
                    const monthCheckins = allTrackers.filter(
                      (t) => t.entityId === habit.id && t.timestamp >= monthStartISO,
                    ).length
                    const rate = daysElapsed > 0 ? Math.round((monthCheckins / daysElapsed) * 100) : 0
                    return (
                      <Badge variant="outline" className="text-xs">{rate}% this month</Badge>
                    )
                  })()}

                  {/* Heatmap */}
                  <HabitHeatmap trackers={allTrackers} habitId={habit.id} />

                  {/* Check-in button */}
                  <Button
                    size="sm"
                    variant={checked ? 'default' : 'outline'}
                    className="w-full"
                    onClick={() => handleCheckIn(habit)}
                  >
                    <Check className="h-4 w-4 mr-1" />
                    {checked ? 'Done today' : 'Check in'}
                  </Button>

                  {/* Tags */}
                  {habit.tags.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {habit.tags.map((tag) => (
                        <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">{tag}</span>
                      ))}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-1 pt-1">
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingHabit(habit)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setDeleteTarget(habit)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Create habit dialog */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="habit"
        title="New Habit"
        onSubmit={handleCreateHabit}
      />

      {/* Create protocol dialog */}
      <ProtocolDialog
        open={protocolDialogOpen}
        onOpenChange={setProtocolDialogOpen}
        onSubmit={handleCreateProtocol}
      />

      {/* Edit habit dialog */}
      <EntityDialog
        open={!!editingHabit}
        onOpenChange={(open) => !open && setEditingHabit(null)}
        entityType="habit"
        title="Edit Habit"
        defaultValues={editingHabit ?? undefined}
        onSubmit={handleEditHabit}
      />

      {/* Edit protocol dialog */}
      <ProtocolDialog
        open={!!editingProtocol}
        onOpenChange={(open) => !open && setEditingProtocol(null)}
        title="Edit Protocol"
        defaultValues={editingProtocol ? {
          title: editingProtocol.title,
          description: editingProtocol.description || '',
          steps: (editingProtocol.metadata.steps as ProtocolStep[]) || [],
        } : undefined}
        onSubmit={handleEditProtocol}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget && isProtocol(deleteTarget) ? 'Protocol' : 'Habit'}`}
        description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
        onConfirm={() => {
          if (deleteTarget) {
            const label = isProtocol(deleteTarget) ? 'Protocol' : 'Habit'
            remove.mutate(deleteTarget.id)
            notify({ title: `${label} deleted`, type: 'success' })
            setDeleteTarget(null)
          }
        }}
      />
    </div>
  )
}
