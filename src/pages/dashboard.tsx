import { useState, useMemo } from 'react'
import { CheckSquare, Target, Repeat, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { useEntities, useTrackers } from '@/core/hooks'
import { EntityDialog } from '@/core/components/entity-dialog'
import { useAuthStore } from '@/stores/auth-store'
import { DailyBriefWidget } from '@/pages/ai/daily-brief-widget'
import type { Entity, EntityType, EntityStatus, EntityPriority } from '@/core/types'

export function DashboardPage() {
  const { items: allEntities, update, create } = useEntities()
  const { items: allTrackers } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [quickAddType, setQuickAddType] = useState<EntityType | null>(null)

  const today = new Date().toISOString().split('T')[0]

  // Today's tasks: due today or overdue and not completed
  const todaysTasks = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          e.type === 'task' &&
          e.status !== 'completed' &&
          e.status !== 'archived' &&
          e.dueDate &&
          e.dueDate <= today,
      ),
    [allEntities, today],
  )

  // Active goals with progress
  const activeGoals = useMemo(
    () =>
      allEntities
        .filter((e) => e.type === 'goal' && e.status === 'active' && !e.parentId)
        .slice(0, 5),
    [allEntities],
  )

  // Active habits with today's check-in status
  const habits = useMemo(() => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayISO = todayStart.toISOString()

    return allEntities
      .filter((e) => e.type === 'habit' && e.status === 'active')
      .map((habit) => {
        const checkedToday = allTrackers.some(
          (t) => t.entityId === habit.id && t.timestamp >= todayISO,
        )
        return { ...habit, checkedToday }
      })
  }, [allEntities, allTrackers])

  const toggleTaskComplete = (task: Entity) => {
    update.mutate({
      id: task.id,
      updates: {
        status: task.status === 'completed' ? 'active' : 'completed',
        updatedAt: new Date().toISOString(),
      },
    })
  }

  const handleQuickAdd = (values: Record<string, unknown>) => {
    if (!quickAddType) return
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    create.mutate({
      id: crypto.randomUUID(),
      type: quickAddType,
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'active',
      priority: (values.priority as EntityPriority) || 'medium',
      tags,
      metadata: quickAddType === 'goal' ? { progress: 0 } : {},
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  const getProgress = (goal: Entity) =>
    typeof goal.metadata.progress === 'number' ? goal.metadata.progress : 0

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {/* Daily Brief */}
      <DailyBriefWidget />

      {/* Today's Tasks */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <CheckSquare className="h-4 w-4 text-muted-foreground" />
            Today's Tasks
          </CardTitle>
        </CardHeader>
        <CardContent>
          {todaysTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">All caught up! No tasks due.</p>
          ) : (
            <div className="space-y-2">
              {todaysTasks.map((task) => (
                <div key={task.id} className="flex items-center gap-2">
                  <Checkbox
                    checked={task.status === 'completed'}
                    onCheckedChange={() => toggleTaskComplete(task)}
                  />
                  <span className="text-sm truncate flex-1">{task.title}</span>
                  {task.dueDate && task.dueDate < today && (
                    <span className="text-xs text-destructive shrink-0">overdue</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Goal Progress */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Target className="h-4 w-4 text-muted-foreground" />
            Goal Progress
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activeGoals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active goals.</p>
          ) : (
            <div className="space-y-3">
              {activeGoals.map((goal) => (
                <div key={goal.id} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="truncate">{goal.title}</span>
                    <span className="text-muted-foreground shrink-0">{getProgress(goal)}%</span>
                  </div>
                  <Progress value={getProgress(goal)} className="h-2" />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Habits */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Repeat className="h-4 w-4 text-muted-foreground" />
            Habits
          </CardTitle>
        </CardHeader>
        <CardContent>
          {habits.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active habits.</p>
          ) : (
            <div className="space-y-2">
              {habits.map((habit) => (
                <div key={habit.id} className="flex items-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      habit.checkedToday ? 'bg-green-500' : 'bg-muted-foreground/30'
                    }`}
                  />
                  <span className="text-sm truncate flex-1">{habit.title}</span>
                  {typeof habit.metadata.streak === 'number' && habit.metadata.streak > 0 && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {habit.metadata.streak as number}d streak
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Add */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Plus className="h-4 w-4 text-muted-foreground" />
            Quick Add
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => setQuickAddType('task')}>
              <CheckSquare className="h-3.5 w-3.5 mr-1" /> Task
            </Button>
            <Button size="sm" variant="outline" onClick={() => setQuickAddType('goal')}>
              <Target className="h-3.5 w-3.5 mr-1" /> Goal
            </Button>
            <Button size="sm" variant="outline" onClick={() => setQuickAddType('event')}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Event
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Quick add dialog */}
      {quickAddType && (
        <EntityDialog
          open={!!quickAddType}
          onOpenChange={(open) => !open && setQuickAddType(null)}
          entityType={quickAddType}
          title={`New ${quickAddType}`}
          onSubmit={handleQuickAdd}
        />
      )}
    </div>
  )
}
