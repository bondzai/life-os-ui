import { useState, useMemo } from 'react'
import { Plus, Target, Pencil, Trash2, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { EntityDetail } from '@/core/components/entity-detail'
import { StatusBadge } from '@/core/components/status-badge'
import { PriorityBadge } from '@/core/components/priority-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import type { Entity, EntityStatus } from '@/core/types'

export function GoalsPage() {
  const { items: allGoals, isLoading, create, update, remove } = useEntities('goal')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingGoal, setEditingGoal] = useState<Entity | null>(null)
  const [selectedGoal, setSelectedGoal] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const goals = useMemo(() => {
    let filtered = allGoals.filter((g) => !g.parentId)
    if (statusFilter !== 'all') {
      filtered = filtered.filter((g) => g.status === statusFilter)
    }
    return filtered
  }, [allGoals, statusFilter])

  const getSubGoals = (parentId: string) =>
    allGoals.filter((g) => g.parentId === parentId)

  const getProgress = (goal: Entity): number => {
    // Auto-compute from sub-goals if they exist
    const subs = allGoals.filter((g) => g.parentId === goal.id)
    if (subs.length > 0) {
      const avg = subs.reduce((sum, s) => sum + (typeof s.metadata.progress === 'number' ? (s.metadata.progress as number) : 0), 0) / subs.length
      return Math.round(avg)
    }
    return typeof goal.metadata.progress === 'number' ? goal.metadata.progress : 0
  }

  const progressColor = (p: number) =>
    p >= 75 ? 'text-green-600' : p >= 25 ? 'text-yellow-600' : 'text-red-600'

  const handleCreate = (values: Record<string, unknown>) => {
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'goal',
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'active',
      priority: (values.priority as Entity['priority']) || 'medium',
      tags,
      metadata: { progress: 0 },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Goal created', type: 'success' })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingGoal) return
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    update.mutate({
      id: editingGoal.id,
      updates: {
        title: values.title as string,
        description: (values.description as string) || undefined,
        status: values.status as EntityStatus,
        priority: values.priority as Entity['priority'],
        tags,
        dueDate: (values.dueDate as string) || undefined,
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Goal updated', type: 'success' })
    setEditingGoal(null)
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  // Detail view for a selected goal
  if (selectedGoal) {
    const fresh = allGoals.find((g) => g.id === selectedGoal.id) ?? selectedGoal
    const subGoals = getSubGoals(fresh.id)

    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelectedGoal(null)}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back to goals
        </Button>

        <EntityDetail entity={fresh}>
          <div className="space-y-4">
            {/* Progress */}
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium">{getProgress(fresh)}%</span>
              </div>
              {subGoals.length > 0 ? (
                <Progress value={getProgress(fresh)} />
              ) : (
                <Slider
                  value={[getProgress(fresh)]}
                  max={100}
                  step={5}
                  onValueChange={([val]) =>
                    update.mutate({
                      id: fresh.id,
                      updates: {
                        metadata: { ...fresh.metadata, progress: val },
                        updatedAt: new Date().toISOString(),
                      },
                    })
                  }
                />
              )}
            </div>

            {/* Sub-goals */}
            {subGoals.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Sub-goals</h4>
                {subGoals.map((sub) => (
                  <Card key={sub.id} className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setSelectedGoal(sub)}>
                    <CardContent className="flex items-center justify-between py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{sub.title}</span>
                        <StatusBadge status={sub.status} />
                      </div>
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <Progress value={getProgress(sub)} className="flex-1" />
                        <span className="text-xs text-muted-foreground w-8 text-right">{getProgress(sub)}%</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => setEditingGoal(fresh)}>
                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDeleteTarget(fresh)}>
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
              </Button>
            </div>
          </div>
        </EntityDetail>

        {/* Edit dialog */}
        <EntityDialog
          open={!!editingGoal}
          onOpenChange={(open) => !open && setEditingGoal(null)}
          entityType="goal"
          title="Edit Goal"
          defaultValues={editingGoal ?? undefined}
          onSubmit={handleEdit}
        />

        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title="Delete Goal"
          description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
          onConfirm={() => {
            if (deleteTarget) {
              remove.mutate(deleteTarget.id)
              notify({ title: 'Goal deleted', type: 'success' })
              setSelectedGoal(null)
              setDeleteTarget(null)
            }
          }}
        />
      </div>
    )
  }

  // List view
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
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Goal
        </Button>
      </div>

      {/* Goal cards grid */}
      {goals.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No goals yet"
          description="Create your first goal to start tracking progress."
          actionLabel="New Goal"
          onAction={() => setDialogOpen(true)}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {goals.map((goal) => {
            const subGoals = getSubGoals(goal.id)
            const progress = getProgress(goal)
            return (
              <Card
                key={goal.id}
                className="cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => setSelectedGoal(goal)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-sm font-medium">{goal.title}</CardTitle>
                    <div className="flex gap-1">
                      <PriorityBadge priority={goal.priority} />
                      <StatusBadge status={goal.status} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {goal.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {goal.description}
                    </p>
                  )}
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Progress</span>
                      <span className={progressColor(progress)}>{progress}%</span>
                    </div>
                    <Progress value={progress} className="h-2" />
                  </div>
                  {subGoals.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {subGoals.length} sub-goal{subGoals.length > 1 ? 's' : ''}
                    </p>
                  )}
                  {goal.dueDate && (
                    <p className="text-xs text-muted-foreground">
                      Due: {new Date(goal.dueDate).toLocaleDateString()}
                    </p>
                  )}
                  {goal.tags.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {goal.tags.map((tag) => (
                        <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
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
        entityType="goal"
        title="New Goal"
        onSubmit={handleCreate}
      />
    </div>
  )
}
