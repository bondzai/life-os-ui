import { useState, useMemo, useCallback } from 'react'
import { Plus, CheckSquare, List, Columns3, ChevronRight, BarChart3, ClipboardList, ListChecks, Archive, ArrowRight } from 'lucide-react'
import { DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable, type DragEndEvent } from '@dnd-kit/core'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import { StoryDialog } from './tasks/story-dialog'
import { TaskDetailPanel } from './tasks/task-detail-panel'
import { TaskFilters, applyTaskFilters, defaultFilters, type TaskFilterState } from './tasks/task-filters'
import { isStory } from './tasks/task-helpers'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'

type ViewMode = 'list' | 'kanban' | 'backlog' | 'log'

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
  const diff = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - diff)
  d.setHours(0, 0, 0, 0)
  return d
}

// ── Drag-and-drop wrappers ────────────────────────────────────────────

function DraggableTask({ task, children }: { task: Entity; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id })
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? 'opacity-30' : ''}>
      {children}
    </div>
  )
}

function DroppableStory({ storyId, children }: { storyId: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `story-${storyId}` })
  return (
    <div ref={setNodeRef} className={isOver ? 'ring-2 ring-primary ring-offset-2 rounded-lg transition-all' : ''}>
      {children}
    </div>
  )
}

// ── List view task wrapper ────────────────────────────────────────────

function ListTaskWrapper({
  task,
  selectedTasks,
  setSelectedTasks,
  children,
}: {
  task: Entity
  selectedTasks: Set<string>
  setSelectedTasks: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void
  children: React.ReactNode
}) {
  if (isStory(task)) {
    return (
      <DroppableStory storyId={task.id}>
        {children}
      </DroppableStory>
    )
  }

  return (
    <DraggableTask task={task}>
      <div className="flex items-start gap-2">
        <Checkbox
          checked={selectedTasks.has(task.id)}
          onCheckedChange={(checked) => {
            setSelectedTasks(prev => {
              const next = new Set(prev)
              if (checked) next.add(task.id)
              else next.delete(task.id)
              return next
            })
          }}
          className="mt-3 shrink-0"
        />
        <div className="flex-1">
          {children}
        </div>
      </div>
    </DraggableTask>
  )
}

// ── Component ─────────────────────────────────────────────────────────

export function TasksPage() {
  const { items: tasks, isLoading, create, update, remove } = useEntities('task')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [view, setView] = useState<ViewMode>('list')
  const [filters, setFilters] = useState<TaskFilterState>({ ...defaultFilters, priorities: new Set() })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [storyDialogOpen, setStoryDialogOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [standupOpen, setStandupOpen] = useState(false)
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set())
  const [mergeSubtasks, setMergeSubtasks] = useState<Array<{ id: string; title: string; done: boolean }>>([])

  // Detail panel state
  const [detailTask, setDetailTask] = useState<Entity | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  // DnD sensors
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  // ── Task key map ────────────────────────────────────────────────────

  const taskKeyMap = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const map = new Map<string, string>()
    sorted.forEach((t, i) => map.set(t.id, `LY-${String(i + 1).padStart(3, '0')}`))
    return map
  }, [tasks])

  // ── Filtered tasks ──────────────────────────────────────────────────

  const filteredTasks = useMemo(() => applyTaskFilters(tasks, filters), [tasks, filters])

  // ── Time-grouped list view ──────────────────────────────────────────

  const todayStr = new Date().toISOString().split('T')[0]
  const tomorrowStr = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0] })()
  const weekEndStr = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().split('T')[0] })()

  const sortByPriority = (items: Entity[]) =>
    [...items].sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2))

  const activeWsTasks = useMemo(
    () => filteredTasks.filter((t) => t.status === 'todo' || t.status === 'in-progress'),
    [filteredTasks],
  )

  const backlogTasks = useMemo(
    () => sortByPriority(filteredTasks.filter((t) => t.status === 'backlog')),
    [filteredTasks],
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
    () => filteredTasks.filter((t) => t.status === 'done' && t.updatedAt?.startsWith(todayStr)),
    [filteredTasks, todayStr],
  )

  const hasAnyListTasks = todayGroup.length > 0 || tomorrowGroup.length > 0 || thisWeekGroup.length > 0 || laterGroup.length > 0 || backlogGroup.length > 0 || backlogTasks.length > 0 || doneToday.length > 0

  // Existing stories for "Add to Story" dropdown
  const existingStories = useMemo(
    () => filteredTasks.filter(t => t.status === 'todo' && isStory(t)),
    [filteredTasks],
  )

  // ── Log view data ───────────────────────────────────────────────────

  const completedTasks = useMemo(
    () =>
      filteredTasks
        .filter((t) => t.status === 'done')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [filteredTasks],
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

    const days = getLast14Days()
    const countByDate = new Map<string, number>()
    for (const t of completedTasks) {
      const dateKey = t.updatedAt.split('T')[0]
      countByDate.set(dateKey, (countByDate.get(dateKey) ?? 0) + 1)
    }
    const chartData = days.map((d) => ({ ...d, count: countByDate.get(d.date) ?? 0 }))

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

  // ── Handlers ────────────────────────────────────────────────────────

  const openDetail = useCallback((task: Entity) => {
    setDetailTask(task)
    setDetailOpen(true)
  }, [])

  const handleDetailUpdate = useCallback((id: string, updates: Partial<Entity>) => {
    update.mutate({
      id,
      updates: { ...updates, updatedAt: new Date().toISOString() },
    })
    // Keep detail panel in sync
    setDetailTask((prev) => prev && prev.id === id ? { ...prev, ...updates } : prev)
  }, [update])

  const handleLinkTask = useCallback((parentId: string, childTask: Entity) => {
    const parent = tasks.find((t) => t.id === parentId)
    if (!parent) return

    const existingSubs = Array.isArray(parent.metadata.subtasks)
      ? (parent.metadata.subtasks as Array<{ id: string; title: string; done: boolean }>)
      : []

    // Add child task as subtask
    update.mutate({
      id: parentId,
      updates: {
        metadata: {
          ...parent.metadata,
          subtasks: [...existingSubs, { id: crypto.randomUUID(), title: childTask.title, done: childTask.status === 'done', status: (childTask.status === 'done' ? 'done' : 'todo') as 'todo' | 'done' }],
        },
        updatedAt: new Date().toISOString(),
      },
    })

    // Archive the original task
    update.mutate({
      id: childTask.id,
      updates: { status: 'archived' as EntityStatus, updatedAt: new Date().toISOString() },
    })

    // Update detail panel state
    setDetailTask((prev) => {
      if (!prev || prev.id !== parentId) return prev
      const prevSubs = Array.isArray(prev.metadata.subtasks)
        ? (prev.metadata.subtasks as Array<{ id: string; title: string; done: boolean }>)
        : []
      return {
        ...prev,
        metadata: {
          ...prev.metadata,
          subtasks: [...prevSubs, { id: crypto.randomUUID(), title: childTask.title, done: childTask.status === 'done', status: (childTask.status === 'done' ? 'done' : 'todo') as 'todo' | 'done' }],
        },
      }
    })

    notify({ title: `"${childTask.title}" linked as subtask`, type: 'success' })
  }, [tasks, update])

  const handleDetailDelete = useCallback((task: Entity) => {
    remove.mutate(task.id)
    notify({ title: 'Task deleted', type: 'success' })
    setDetailOpen(false)
    setDetailTask(null)
  }, [remove])

  const toggleComplete = (task: Entity) => {
    const newStatus = task.status === 'done' ? 'todo' : 'done'
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

  const handleMergeIntoNewStory = () => {
    const selected = tasks.filter(t => selectedTasks.has(t.id))
    setMergeSubtasks(selected.map(t => ({ id: crypto.randomUUID(), title: t.title, done: t.status === 'done' })))
    setStoryDialogOpen(true)
    setSelectedTasks(new Set())
  }

  const handleAddToStory = (storyId: string) => {
    const story = tasks.find(t => t.id === storyId)
    if (!story) return

    const existingSubs = Array.isArray(story.metadata.subtasks)
      ? (story.metadata.subtasks as Array<{ id: string; title: string; done: boolean }>)
      : []

    const selected = tasks.filter(t => selectedTasks.has(t.id))
    const newSubs = selected.map(t => ({
      id: crypto.randomUUID(),
      title: t.title,
      done: t.status === 'done',
      status: (t.status === 'done' ? 'done' : 'todo') as 'todo' | 'done',
    }))

    update.mutate({
      id: storyId,
      updates: {
        metadata: { ...story.metadata, subtasks: [...existingSubs, ...newSubs] },
        updatedAt: new Date().toISOString(),
      },
    })

    for (const t of selected) {
      update.mutate({
        id: t.id,
        updates: { status: 'archived' as EntityStatus, updatedAt: new Date().toISOString() },
      })
    }

    setSelectedTasks(new Set())
    notify({ title: `${selected.length} task${selected.length > 1 ? 's' : ''} added to story`, type: 'success' })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return

    const overId = String(over.id)
    if (!overId.startsWith('story-')) return

    const taskId = String(active.id)
    const storyId = overId.replace('story-', '')

    const task = tasks.find(t => t.id === taskId)
    const story = tasks.find(t => t.id === storyId)
    if (!task || !story) return

    const existingSubs = Array.isArray(story.metadata.subtasks)
      ? (story.metadata.subtasks as Array<{ id: string; title: string; done: boolean }>)
      : []

    update.mutate({
      id: storyId,
      updates: {
        metadata: { ...story.metadata, subtasks: [...existingSubs, { id: crypto.randomUUID(), title: task.title, done: task.status === 'done', status: (task.status === 'done' ? 'done' : 'todo') as 'todo' | 'done' }] },
        updatedAt: new Date().toISOString(),
      },
    })

    update.mutate({
      id: taskId,
      updates: { status: 'archived' as EntityStatus, updatedAt: new Date().toISOString() },
    })

    notify({ title: `"${task.title}" added to "${story.title}"`, type: 'success' })
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
      status: (values.status as EntityStatus) || 'todo',
      priority: (values.priority as EntityPriority) || 'medium',
      tags,
      metadata: {
        workspace: filters.workspace !== 'all' ? filters.workspace : undefined,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Task created', type: 'success' })
  }

  const handleQuickAdd = (title: string, status: EntityStatus) => {
    create.mutate({
      id: crypto.randomUUID(),
      type: 'task',
      title,
      status,
      priority: 'medium',
      tags: [],
      metadata: {
        workspace: filters.workspace !== 'all' ? filters.workspace : undefined,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Task created', type: 'success' })
  }

  const handleCreateStory = (values: {
    title: string; description: string; priority: string; dueDate: string; workspace: string; subtasks: Array<{ id: string; title: string; done: boolean }>
  }) => {
    create.mutate({
      id: crypto.randomUUID(),
      type: 'task',
      title: values.title,
      description: values.description || undefined,
      status: 'todo',
      priority: (values.priority as EntityPriority) || 'high',
      tags: [],
      metadata: {
        workspace: values.workspace || undefined,
        subtasks: values.subtasks,
        isStory: true,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: values.dueDate || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Story created', type: 'success' })
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

  // ── Render helper for task list items ───────────────────────────────

  const renderTaskCard = (task: Entity) => (
    <TaskCard
      task={task}
      taskKey={taskKeyMap.get(task.id)}
      onClick={() => openDetail(task)}
      onToggleComplete={toggleComplete}
      onMoveToStatus={moveToStatus}
      onEdit={setEditingTask}
      onDelete={setDeleteTarget}
      onSnooze={snoozeTask}
    />
  )

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Workspace switcher — Jira-style top-level navigation */}
      <div className="flex items-center justify-between border-b pb-3">
        <div className="flex items-center gap-1">
          {(['all', 'work', 'personal'] as const).map((ws) => (
            <button
              key={ws}
              onClick={() => setFilters((f) => ({ ...f, workspace: ws }))}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                filters.workspace === ws
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              {ws === 'all' ? 'All Projects' : ws === 'work' ? '🏢 Work' : '🏠 Personal'}
              <span className={`ml-2 text-xs ${filters.workspace === ws ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                {ws === 'all'
                  ? tasks.filter((t) => t.status !== 'archived').length
                  : tasks.filter((t) => t.metadata.workspace === ws && t.status !== 'archived').length}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setStandupOpen(true)}>
            <ClipboardList className="h-4 w-4 mr-1" /> Standup
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" /> New
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setDialogOpen(true)}>
                <CheckSquare className="h-4 w-4 mr-2" /> Task
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStoryDialogOpen(true)}>
                <ListChecks className="h-4 w-4 mr-2" /> Story
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* View tabs + filters */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <Tabs value={view} onValueChange={(v) => { setView(v as ViewMode); setSelectedTasks(new Set()) }}>
          <TabsList>
            <TabsTrigger value="list">
              <List className="h-4 w-4 mr-1" /> List
            </TabsTrigger>
            <TabsTrigger value="kanban">
              <Columns3 className="h-4 w-4 mr-1" /> Board
            </TabsTrigger>
            <TabsTrigger value="backlog">
              <Archive className="h-4 w-4 mr-1" /> Backlog
              {backlogTasks.length > 0 && (
                <span className="ml-1 text-[10px] bg-muted rounded-full px-1.5 py-0.5">{backlogTasks.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="log">
              <BarChart3 className="h-4 w-4 mr-1" /> Log
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Filters bar (no workspace — it's in the top switcher now) */}
      <TaskFilters filters={filters} onChange={setFilters} />

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
            description={filters.search || filters.priorities.size > 0 || filters.type !== 'all' ? 'Try adjusting your filters.' : 'Create a task to get started.'}
            actionLabel={filters.search || filters.priorities.size > 0 || filters.type !== 'all' ? undefined : 'New Task'}
            onAction={() => setDialogOpen(true)}
          />
        ) : (
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="space-y-6">
            {/* Today */}
            {todayGroup.length > 0 && (
              <div className="space-y-0">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 pb-2 flex items-center gap-2">
                  Today
                  <span className="text-[10px] font-medium bg-muted rounded-full px-1.5 py-0.5">{todayGroup.length}</span>
                </h3>
                <div className="rounded-lg border">
                  {todayGroup.map((task) => (
                    <ListTaskWrapper key={task.id} task={task} selectedTasks={selectedTasks} setSelectedTasks={setSelectedTasks}>
                      {renderTaskCard(task)}
                    </ListTaskWrapper>
                  ))}
                </div>
              </div>
            )}

            {/* Upcoming sections */}
            {(tomorrowGroup.length > 0 || thisWeekGroup.length > 0 || laterGroup.length > 0) && (
              <div className="space-y-4">
                {tomorrowGroup.length > 0 && (
                  <div className="space-y-0">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 pb-2 flex items-center gap-2">
                      Tomorrow
                      <span className="text-[10px] font-medium bg-muted rounded-full px-1.5 py-0.5">{tomorrowGroup.length}</span>
                    </h3>
                    <div className="rounded-lg border">
                      {tomorrowGroup.map((task) => (
                        <ListTaskWrapper key={task.id} task={task} selectedTasks={selectedTasks} setSelectedTasks={setSelectedTasks}>
                          {renderTaskCard(task)}
                        </ListTaskWrapper>
                      ))}
                    </div>
                  </div>
                )}

                {thisWeekGroup.length > 0 && (
                  <div className="space-y-0">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 pb-2 flex items-center gap-2">
                      This Week
                      <span className="text-[10px] font-medium bg-muted rounded-full px-1.5 py-0.5">{thisWeekGroup.length}</span>
                    </h3>
                    <div className="rounded-lg border">
                      {thisWeekGroup.map((task) => (
                        <ListTaskWrapper key={task.id} task={task} selectedTasks={selectedTasks} setSelectedTasks={setSelectedTasks}>
                          {renderTaskCard(task)}
                        </ListTaskWrapper>
                      ))}
                    </div>
                  </div>
                )}

                {laterGroup.length > 0 && (
                  <div className="space-y-0">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 pb-2 flex items-center gap-2">
                      Later
                      <span className="text-[10px] font-medium bg-muted rounded-full px-1.5 py-0.5">{laterGroup.length}</span>
                    </h3>
                    <div className="rounded-lg border">
                      {laterGroup.map((task) => (
                        <ListTaskWrapper key={task.id} task={task} selectedTasks={selectedTasks} setSelectedTasks={setSelectedTasks}>
                          {renderTaskCard(task)}
                        </ListTaskWrapper>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* No due date */}
            {backlogGroup.length > 0 && (
              <div className="space-y-0">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 pb-2 flex items-center gap-2">
                  No Due Date
                  <span className="text-[10px] font-medium bg-muted rounded-full px-1.5 py-0.5">{backlogGroup.length}</span>
                </h3>
                <div className="rounded-lg border">
                  {backlogGroup.map((task) => (
                    <ListTaskWrapper key={task.id} task={task} selectedTasks={selectedTasks} setSelectedTasks={setSelectedTasks}>
                      {renderTaskCard(task)}
                    </ListTaskWrapper>
                  ))}
                </div>
              </div>
            )}

            {/* Done Today */}
            {doneToday.length > 0 && (
              <Collapsible open={showDone} onOpenChange={setShowDone}>
                <CollapsibleTrigger className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 py-2">
                  <ChevronRight
                    className={`h-3.5 w-3.5 transition-transform ${showDone ? 'rotate-90' : ''}`}
                  />
                  Done Today
                  <span className="text-[10px] font-medium bg-muted rounded-full px-1.5 py-0.5">{doneToday.length}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="rounded-lg border opacity-60">
                    {doneToday.map((task) => (
                      <div key={task.id}>
                        {renderTaskCard(task)}
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>

          {/* Floating action bar for multi-select */}
          {selectedTasks.size > 0 && (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-background border rounded-full shadow-lg px-4 py-2 flex items-center gap-3 z-50">
              <span className="text-sm font-medium">{selectedTasks.size} selected</span>
              <Button size="sm" variant="default" onClick={handleMergeIntoNewStory}>
                <ListChecks className="h-3.5 w-3.5 mr-1.5" /> Create Story
              </Button>
              {existingStories.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">Add to Story &#9662;</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {existingStories.map(story => (
                      <DropdownMenuItem key={story.id} onClick={() => handleAddToStory(story.id)}>
                        {story.title}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSelectedTasks(new Set())}>
                Cancel
              </Button>
            </div>
          )}
          </DndContext>
        )
      ) : view === 'kanban' ? (
        <KanbanBoard
          tasks={filteredTasks}
          onToggleComplete={toggleComplete}
          onMoveToStatus={moveToStatus}
          onEdit={setEditingTask}
          onDelete={setDeleteTarget}
          onSnooze={snoozeTask}
          onTaskClick={openDetail}
          onQuickAdd={handleQuickAdd}
        />
      ) : view === 'backlog' ? (
        /* Backlog view — Jira-style full backlog list */
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
            <div className="flex items-center gap-4">
              <div className="text-center">
                <p className="text-2xl font-bold">{backlogTasks.length}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Items</p>
              </div>
              <div className="h-8 border-r" />
              <div className="text-center">
                <p className="text-2xl font-bold">
                  {backlogTasks.reduce((sum, t) => sum + (typeof t.metadata.points === 'number' ? t.metadata.points : 0), 0)}
                </p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Points</p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={selectedTasks.size === 0}
              onClick={() => {
                for (const id of selectedTasks) {
                  update.mutate({
                    id,
                    updates: { status: 'todo' as EntityStatus, updatedAt: new Date().toISOString() },
                  })
                }
                notify({ title: `${selectedTasks.size} item${selectedTasks.size > 1 ? 's' : ''} moved to To Do`, type: 'success' })
                setSelectedTasks(new Set())
              }}
            >
              <ArrowRight className="h-3.5 w-3.5" />
              Move to To Do {selectedTasks.size > 0 && `(${selectedTasks.size})`}
            </Button>
          </div>

          {backlogTasks.length === 0 ? (
            <EmptyState
              icon={Archive}
              title="Backlog is empty"
              description="Items moved to backlog will appear here. Create a task and set its status to Backlog."
            />
          ) : (
            <div className="rounded-lg border">
              {/* Header row */}
              <div className="flex items-center gap-2 px-2 py-2 border-b bg-muted/30 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <div className="w-6 shrink-0" />
                <div className="w-6 shrink-0" />
                <span className="w-16 shrink-0">Key</span>
                <span className="flex-1">Title</span>
                <span className="w-14 shrink-0 text-center">Points</span>
                <span className="w-16 shrink-0">Priority</span>
                <span className="w-20 shrink-0">Workspace</span>
                <div className="w-20 shrink-0" />
              </div>
              {backlogTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center gap-2 px-2 py-2 border-b last:border-b-0 hover:bg-muted/50 transition-colors group cursor-pointer"
                  onClick={() => openDetail(task)}
                >
                  {/* Select */}
                  <Checkbox
                    checked={selectedTasks.has(task.id)}
                    onCheckedChange={(checked) => {
                      setSelectedTasks(prev => {
                        const next = new Set(prev)
                        if (checked) next.add(task.id)
                        else next.delete(task.id)
                        return next
                      })
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0"
                  />
                  {/* Type icon */}
                  {isStory(task) ? (
                    <ListChecks className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <CheckSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  {/* Key */}
                  <span className="text-xs font-mono text-muted-foreground w-16 shrink-0">{taskKeyMap.get(task.id)}</span>
                  {/* Title */}
                  <span className="text-sm truncate flex-1">{task.title}</span>
                  {/* Points */}
                  <span className="w-14 shrink-0 text-center">
                    {typeof task.metadata.points === 'number' ? (
                      <span className="text-xs font-mono bg-muted rounded px-1.5 py-0.5">{task.metadata.points}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </span>
                  {/* Priority */}
                  <span className={`text-xs w-16 shrink-0 capitalize ${
                    task.priority === 'urgent' ? 'text-red-500' :
                    task.priority === 'high' ? 'text-orange-500' :
                    task.priority === 'medium' ? 'text-yellow-500' : 'text-gray-400'
                  }`}>
                    {task.priority}
                  </span>
                  {/* Workspace */}
                  <span className="w-20 shrink-0">
                    {typeof task.metadata.workspace === 'string' ? (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        task.metadata.workspace === 'work'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      }`}>
                        {task.metadata.workspace === 'work' ? 'Work' : 'Personal'}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </span>
                  {/* Actions */}
                  <div className="w-20 shrink-0 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] px-2 gap-1"
                      onClick={(e) => {
                        e.stopPropagation()
                        update.mutate({
                          id: task.id,
                          updates: { status: 'todo' as EntityStatus, updatedAt: new Date().toISOString() },
                        })
                        notify({ title: 'Moved to To Do', type: 'success' })
                      }}
                    >
                      <ArrowRight className="h-3 w-3" /> Start
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
                  <CollapsibleContent>
                    <div className="rounded-lg border mt-1 opacity-70">
                      {group.tasks.map((task) => (
                        <div key={task.id}>
                          {renderTaskCard(task)}
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))
            )}
          </div>
        </div>
      )}

      {/* Task detail panel */}
      <TaskDetailPanel
        task={detailTask}
        taskKey={detailTask ? taskKeyMap.get(detailTask.id) : undefined}
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open)
          if (!open) setDetailTask(null)
        }}
        onUpdate={handleDetailUpdate}
        onDelete={handleDetailDelete}
        allTasks={tasks}
        onLinkTask={handleLinkTask}
      />

      {/* Create dialog */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="task"
        title="New Task"
        onSubmit={handleCreate}
      />

      {/* Edit dialog (fallback) */}
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

      {/* Story dialog */}
      <StoryDialog
        open={storyDialogOpen}
        onOpenChange={(open) => {
          setStoryDialogOpen(open)
          if (!open) setMergeSubtasks([])
        }}
        workspace={filters.workspace !== 'all' ? filters.workspace : undefined}
        defaultSubtasks={mergeSubtasks.length > 0 ? mergeSubtasks : undefined}
        onSubmit={handleCreateStory}
      />

      {/* Standup Report Sheet */}
      <StandupReport open={standupOpen} onOpenChange={setStandupOpen} tasks={filteredTasks} />
    </div>
  )
}
