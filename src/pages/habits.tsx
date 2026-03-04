import { useState, useMemo, useCallback } from 'react'
import { Plus, Repeat, Pencil, Trash2, Flame, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { StatusBadge } from '@/core/components/status-badge'
import { PriorityBadge } from '@/core/components/priority-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import { HabitHeatmap } from './habits/habit-heatmap'
import type { Entity, EntityStatus } from '@/core/types'

function getTodayStart(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export function HabitsPage() {
  const { items: allHabits, isLoading, create, update, remove } = useEntities('habit')
  const { items: allTrackers, create: createTracker, remove: removeTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingHabit, setEditingHabit] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const habits = useMemo(() => {
    if (statusFilter === 'all') return allHabits
    return allHabits.filter((h) => h.status === statusFilter)
  }, [allHabits, statusFilter])

  const todayStart = useMemo(() => getTodayStart(), [])

  const getTodayTracker = useCallback(
    (habitId: string) =>
      allTrackers.find(
        (t) => t.entityId === habitId && t.timestamp >= todayStart,
      ),
    [allTrackers, todayStart],
  )

  const handleCheckIn = (habit: Entity) => {
    const existing = getTodayTracker(habit.id)
    if (existing) {
      // Undo check-in
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
      // Check in
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
    }
  }

  const handleCreate = (values: Record<string, unknown>) => {
    const tags =
      typeof values.tags === 'string'
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

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingHabit) return
    const tags =
      typeof values.tags === 'string'
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
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Habit
        </Button>
      </div>

      {/* Habit cards grid */}
      {habits.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="No habits yet"
          description="Create your first habit to start building streaks."
          actionLabel="New Habit"
          onAction={() => setDialogOpen(true)}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {habits.map((habit) => {
            const checked = !!getTodayTracker(habit.id)
            const streak =
              typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0
            const frequency =
              typeof habit.metadata.frequency === 'string'
                ? habit.metadata.frequency
                : 'daily'

            return (
              <Card key={habit.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-sm font-medium">
                        {habit.title}
                      </CardTitle>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Badge variant="outline" className="text-xs capitalize">
                        {frequency}
                      </Badge>
                      <PriorityBadge priority={habit.priority} />
                      <StatusBadge status={habit.status} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {habit.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {habit.description}
                    </p>
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
                      <Badge variant="outline" className="text-xs">
                        {rate}% this month
                      </Badge>
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
                        <span
                          key={tag}
                          className="text-xs bg-secondary px-1.5 py-0.5 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-1 pt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => setEditingHabit(habit)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => setDeleteTarget(habit)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Create dialog */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="habit"
        title="New Habit"
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <EntityDialog
        open={!!editingHabit}
        onOpenChange={(open) => !open && setEditingHabit(null)}
        entityType="habit"
        title="Edit Habit"
        defaultValues={editingHabit ?? undefined}
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
