import { useState, useMemo } from 'react'
import { Plus, CheckSquare, List, Columns3, ChevronRight, BarChart3, ClipboardList } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import { emitAutomationEvent } from './automate/automation-event-bus'
import { TaskCard } from './tasks/task-card'
import { KanbanBoard } from './tasks/kanban-board'
import { StandupReport } from './tasks/standup-report'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'

type ViewMode = 'list' | 'kanban' | 'log'
type Workspace = 'all' | 'work' | 'personal'

const priorityOrder: Record<EntityPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

// ── Log view helpers ──────────────────────────────────────────────────

function getLast14Days(): { date: string; label: string }[] {
  const days: { date: string; label: string }[] = []
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  for (let i = 13; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    days.push({
      date: d.toISOString().split('T')[0],
      label: weekdays[d.getDay()],
    })
  }
  return days
}

function getDateLabel(dateStr: string): { label: string; isToday: boolean; isYesterday: boolean } {
  const today = new Date()
  const todayStr = today.toISOString().split('T')[0]
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toISOString().split('T')[0]

  if (dateStr === todayStr) return { label: 'Today', isToday: true, isYesterday: false }
  if (dateStr === yesterdayStr) return { label: 'Yesterday', isToday: false, isYesterday: true }

  const d = new Date(dateStr + 'T12:00:00')
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  return { label, isToday: false, isYesterday: false }
}

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? 6 : day - 1 // Monday as start
  d.setDate(d.getDate() - diff)
  d.setHours(0, 0, 0, 0)
  return d
}

// ── Component ─────────────────────────────────────────────────────────

export function TasksPage() {
  const { items: tasks, isLoading, create, update, remove } = useEntities('task')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [view, setView] = useState<ViewMode>('list')
  const [workspace, setWorkspace] = useState<Workspace>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [standupOpen, setStandupOpen] = useState(false)

  // ── Workspace filter ──────────────────────────────────────────────

  const workspaceTasks = useMemo(() => {
    if (workspace === 'all') return tasks
    return tasks.filter((t) => t.metadata.workspace === workspace)
  }, [tasks, workspace])

  // ── Time-grouped list view ───────────────────────────────────────

  const todayStr = new Date().toISOString().split('T')[0]
  const tomorrowStr = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0] })()
  const weekEndStr = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().split('T')[0] })()

  const sortByPriority = (items: Entity[]) =>
    [...items].sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2))

  const activeWsTasks = useMemo(
    () => workspaceTasks.filter((t) => t.status === 'active' || t.status === 'paused'),
    [workspaceTasks],
  )

  const todayGroup = useMemo(
    () => sortByPriority(activeWsTasks.filter((t) => t.dueDate && t.dueDate <= todayStr)),
    [activeWsTasks, todayStr],
  )
  const tomorrowGroup = useMemo(
    () => sortByPriority(activeWsTasks.filter((t) => t.dueDate === tomorrowStr)),
    [activeWsTasks, tomorrowStr],
  )
  const thisWeekGroup = useMemo(
    () => sortByPriority(activeWsTasks.filter((t) => t.dueDate && t.dueDate > tomorrowStr && t.dueDate <= weekEndStr)),
    [activeWsTasks, tomorrowStr, weekEndStr],
  )
  const laterGroup = useMemo(
    () => sortByPriority(activeWsTasks.filter((t) => t.dueDate && t.dueDate > weekEndStr)),
    [activeWsTasks, weekEndStr],
  )
  const backlogGroup = useMemo(
    () => sortByPriority(activeWsTasks.filter((t) => !t.dueDate)),
    [activeWsTasks],
  )

  const doneToday = useMemo(
    () => workspaceTasks.filter((t) => t.status === 'completed' && t.updatedAt?.startsWith(todayStr)),
    [workspaceTasks, todayStr],
  )

  const hasAnyListTasks = todayGroup.length > 0 || tomorrowGroup.length > 0 || thisWeekGroup.length > 0 || laterGroup.length > 0 || backlogGroup.length > 0 || doneToday.length > 0

  // ── Log view data (Feature 3) ─────────────────────────────────────

  const completedTasks = useMemo(
    () =>
      workspaceTasks
        .filter((t) => t.status === 'completed')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [workspaceTasks],
  )

  const { thisWeekCount, lastWeekCount, last14DaysData, dateGroups } = useMemo(() => {
    const now = new Date()
    const thisWeekStart = startOfWeek(now)
    const lastWeekStart = new Date(thisWeekStart)
    lastWeekStart.setDate(lastWeekStart.getDate() - 7)

    let twc = 0
    let lwc = 0
    for (const t of completedTasks) {
      const d = new Date(t.updatedAt)
      if (d >= thisWeekStart) twc++
      else if (d >= lastWeekStart && d < thisWeekStart) lwc++
    }

    // 14-day chart
    const days = getLast14Days()
    const countByDate = new Map<string, number>()
    for (const t of completedTasks) {
      const dateKey = t.updatedAt.split('T')[0]
      countByDate.set(dateKey, (countByDate.get(dateKey) ?? 0) + 1)
    }
    const chartData = days.map((d) => ({ ...d, count: countByDate.get(d.date) ?? 0 }))

    // Group by date
    const grouped = new Map<string, Entity[]>()
    for (const t of completedTasks) {
      const dateKey = t.updatedAt.split('T')[0]
      if (!grouped.has(dateKey)) grouped.set(dateKey, [])
      grouped.get(dateKey)!.push(t)
    }
    const groups = Array.from(grouped.entries()).map(([date, tks]) => {
      const { label, isToday, isYesterday } = getDateLabel(date)
      return { date, label, isToday, isYesterday, tasks: tks }
    })

    return {
      thisWeekCount: twc,
      lastWeekCount: lwc,
      last14DaysData: chartData,
      dateGroups: groups,
    }
  }, [completedTasks])

  const maxChartCount = useMemo(
    () => Math.max(1, ...last14DaysData.map((d) => d.count)),
    [last14DaysData],
  )

  // ── Handlers ──────────────────────────────────────────────────────

  const toggleComplete = (task: Entity) => {
    const newStatus = task.status === 'completed' ? 'active' : 'completed'
    update.mutate({
      id: task.id,
      updates: {
        status: newStatus,
        updatedAt: new Date().toISOString(),
      },
    })
    emitAutomationEvent({
      type: 'entity-status-change',
      entityId: task.id,
      entityType: 'task',
      oldStatus: task.status,
      newStatus,
    })
  }

  const snoozeTask = (task: Entity, days: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    const newDueDate = d.toISOString().split('T')[0]
    update.mutate({
      id: task.id,
      updates: { dueDate: newDueDate, updatedAt: new Date().toISOString() },
    })
    notify({ title: `Task snoozed ${days === 1 ? '1 day' : '1 week'}`, type: 'success' })
  }

  const moveToStatus = (task: Entity, newStatus: EntityStatus) => {
    update.mutate({
      id: task.id,
      updates: { status: newStatus, updatedAt: new Date().toISOString() },
    })
    emitAutomationEvent({
      type: 'entity-status-change',
      entityId: task.id,
      entityType: 'task',
      oldStatus: task.status,
      newStatus,
    })
  }

  const handleCreate = (values: Record<string, unknown>) => {
    const tags =
      typeof values.tags === 'string'
        ? values.tags
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'task',
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'active',
      priority: (values.priority as EntityPriority) || 'medium',
      tags,
      metadata: {
        workspace: workspace !== 'all' ? workspace : undefined,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Task created', type: 'success' })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingTask) return
    const tags =
      typeof values.tags === 'string'
        ? values.tags
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : []
    update.mutate({
      id: editingTask.id,
      updates: {
        title: values.title as string,
        description: (values.description as string) || undefined,
        status: values.status as EntityStatus,
        priority: values.priority as EntityPriority,
        tags,
        dueDate: (values.dueDate as string) || undefined,
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Task updated', type: 'success' })
    setEditingTask(null)
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Workspace Tabs */}
      <div className="flex bg-muted rounded-lg p-0.5 gap-0.5 w-fit">
        {(['all', 'work', 'personal'] as const).map((ws) => (
          <button
            key={ws}
            onClick={() => setWorkspace(ws)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              workspace === ws
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {ws === 'all' ? 'All' : ws === 'work' ? '🏢 Work' : '🏠 Personal'}
          </button>
        ))}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <Tabs value={view} onValueChange={(v) => setView(v as ViewMode)}>
            <TabsList>
              <TabsTrigger value="list">
                <List className="h-4 w-4 mr-1" /> List
              </TabsTrigger>
              <TabsTrigger value="kanban">
                <Columns3 className="h-4 w-4 mr-1" /> Board
              </TabsTrigger>
              <TabsTrigger value="log">
                <BarChart3 className="h-4 w-4 mr-1" /> Log
              </TabsTrigger>
            </TabsList>
          </Tabs>

        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setStandupOpen(true)}>
            <ClipboardList className="h-4 w-4 mr-1" /> Standup
          </Button>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Task
          </Button>
        </div>
      </div>

      {/* Content */}
      {tasks.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title="No tasks yet"
          description="Create your first task to get started."
          actionLabel="New Task"
          onAction={() => setDialogOpen(true)}
        />
      ) : view === 'list' ? (
        !hasAnyListTasks ? (
          <EmptyState
            icon={CheckSquare}
            title="No tasks"
            description="Create a task to get started."
            actionLabel="New Task"
            onAction={() => setDialogOpen(true)}
          />
        ) : (
          <div className="space-y-6">
            {/* Today */}
            {todayGroup.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  Today
                  <span className="text-xs text-muted-foreground">({todayGroup.length})</span>
                </h3>
                <div className="space-y-2">
                  {todayGroup.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onToggleComplete={toggleComplete}
                      onMoveToStatus={moveToStatus}
                      onEdit={setEditingTask}
                      onDelete={setDeleteTarget}
                      onSnooze={snoozeTask}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Upcoming */}
            {(tomorrowGroup.length > 0 || thisWeekGroup.length > 0 || laterGroup.length > 0) && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Upcoming</h3>

                {tomorrowGroup.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground ml-1">Tomorrow</p>
                    {tomorrowGroup.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onToggleComplete={toggleComplete}
                        onMoveToStatus={moveToStatus}
                        onEdit={setEditingTask}
                        onDelete={setDeleteTarget}
                        onSnooze={snoozeTask}
                      />
                    ))}
                  </div>
                )}

                {thisWeekGroup.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground ml-1">This Week</p>
                    {thisWeekGroup.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onToggleComplete={toggleComplete}
                        onMoveToStatus={moveToStatus}
                        onEdit={setEditingTask}
                        onDelete={setDeleteTarget}
                        onSnooze={snoozeTask}
                      />
                    ))}
                  </div>
                )}

                {laterGroup.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground ml-1">Later</p>
                    {laterGroup.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onToggleComplete={toggleComplete}
                        onMoveToStatus={moveToStatus}
                        onEdit={setEditingTask}
                        onDelete={setDeleteTarget}
                        onSnooze={snoozeTask}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Backlog */}
            {backlogGroup.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  Backlog
                  <span className="text-xs text-muted-foreground">({backlogGroup.length})</span>
                </h3>
                {backlogGroup.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onToggleComplete={toggleComplete}
                    onMoveToStatus={moveToStatus}
                    onEdit={setEditingTask}
                    onDelete={setDeleteTarget}
                    onSnooze={snoozeTask}
                  />
                ))}
              </div>
            )}

            {/* Done Today */}
            {doneToday.length > 0 && (
              <Collapsible open={showDone} onOpenChange={setShowDone}>
                <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <ChevronRight
                    className={`h-3.5 w-3.5 transition-transform ${showDone ? 'rotate-90' : ''}`}
                  />
                  Done Today ({doneToday.length})
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2">
                  {doneToday.map((task) => (
                    <div key={task.id} className="opacity-50">
                      <TaskCard
                        task={task}
                        onToggleComplete={toggleComplete}
                        onMoveToStatus={moveToStatus}
                        onEdit={setEditingTask}
                        onDelete={setDeleteTarget}
                        onSnooze={snoozeTask}
                      />
                    </div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )
      ) : view === 'kanban' ? (
        <KanbanBoard
          tasks={workspaceTasks}
          onToggleComplete={toggleComplete}
          onMoveToStatus={moveToStatus}
          onEdit={setEditingTask}
          onDelete={setDeleteTarget}
          onSnooze={snoozeTask}
        />
      ) : (
        /* Log view */
        <div className="space-y-6">
          {/* Weekly summary */}
          <Card>
            <CardContent className="py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">This Week</span>
                <span className="text-2xl font-bold">{thisWeekCount}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {thisWeekCount - lastWeekCount > 0
                  ? `+${thisWeekCount - lastWeekCount}`
                  : thisWeekCount - lastWeekCount}{' '}
                vs last week
              </p>
            </CardContent>
          </Card>

          {/* 14-day completion chart */}
          <Card>
            <CardContent className="py-4">
              <h3 className="text-sm font-medium mb-3">Completion Activity</h3>
              <div className="flex items-end gap-1 h-20">
                {last14DaysData.map((day) => (
                  <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full bg-primary/80 rounded-t"
                      style={{
                        height: `${(day.count / maxChartCount) * 100}%`,
                        minHeight: day.count > 0 ? 4 : 0,
                      }}
                    />
                    <span className="text-[10px] text-muted-foreground">{day.label}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Completed tasks grouped by date */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium">Completed Tasks</h3>
            {dateGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No completed tasks yet.</p>
            ) : (
              dateGroups.map((group) => (
                <Collapsible
                  key={group.date}
                  defaultOpen={group.isToday || group.isYesterday}
                >
                  <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium py-1">
                    <ChevronRight className="h-4 w-4 transition-transform [[data-state=open]>&]:rotate-90" />
                    {group.label} ({group.tasks.length})
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 ml-6 mt-1">
                    {group.tasks.map((task) => (
                      <div key={task.id} className="opacity-70">
                        <TaskCard
                          task={task}
                          onToggleComplete={toggleComplete}
                          onMoveToStatus={moveToStatus}
                          onEdit={setEditingTask}
                          onDelete={setDeleteTarget}
                          onSnooze={snoozeTask}
                        />
                      </div>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ))
            )}
          </div>
        </div>
      )}

      {/* Create dialog */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="task"
        title="New Task"
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <EntityDialog
        open={!!editingTask}
        onOpenChange={(open) => !open && setEditingTask(null)}
        entityType="task"
        title="Edit Task"
        defaultValues={editingTask ?? undefined}
        onSubmit={handleEdit}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Task"
        description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate(deleteTarget.id)
            notify({ title: 'Task deleted', type: 'success' })
            setDeleteTarget(null)
          }
        }}
      />

      {/* Standup Report Sheet */}
      <StandupReport open={standupOpen} onOpenChange={setStandupOpen} tasks={workspaceTasks} />
    </div>
  )
}
