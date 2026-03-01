import { useState, useMemo } from 'react'
import { Plus, CheckSquare, List, Columns3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { TaskCard } from './tasks/task-card'
import { KanbanBoard } from './tasks/kanban-board'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'

type SortKey = 'priority' | 'dueDate' | 'createdAt'
type ViewMode = 'list' | 'kanban'

const priorityOrder: Record<EntityPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

export function TasksPage() {
  const { items: tasks, isLoading, create, update, remove } = useEntities('task')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [view, setView] = useState<ViewMode>('list')
  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [priorityFilter, setPriorityFilter] = useState<EntityPriority | 'all'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('priority')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const filteredTasks = useMemo(() => {
    let result = [...tasks]
    if (statusFilter !== 'all') {
      result = result.filter((t) => t.status === statusFilter)
    }
    if (priorityFilter !== 'all') {
      result = result.filter((t) => t.priority === priorityFilter)
    }
    result.sort((a, b) => {
      if (sortKey === 'priority') return priorityOrder[a.priority] - priorityOrder[b.priority]
      if (sortKey === 'dueDate') {
        if (!a.dueDate) return 1
        if (!b.dueDate) return -1
        return a.dueDate.localeCompare(b.dueDate)
      }
      return b.createdAt.localeCompare(a.createdAt)
    })
    return result
  }, [tasks, statusFilter, priorityFilter, sortKey])

  const toggleComplete = (task: Entity) => {
    update.mutate({
      id: task.id,
      updates: {
        status: task.status === 'completed' ? 'active' : 'completed',
        updatedAt: new Date().toISOString(),
      },
    })
  }

  const moveToStatus = (task: Entity, newStatus: EntityStatus) => {
    update.mutate({
      id: task.id,
      updates: { status: newStatus, updatedAt: new Date().toISOString() },
    })
  }

  const handleCreate = (values: Record<string, unknown>) => {
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'task',
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'active',
      priority: (values.priority as EntityPriority) || 'medium',
      tags,
      metadata: {},
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingTask) return
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
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
    setEditingTask(null)
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="space-y-4">
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
            </TabsList>
          </Tabs>

          {view === 'list' && (
            <>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as EntityStatus | 'all')}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
              <Select value={priorityFilter} onValueChange={(v) => setPriorityFilter(v as EntityPriority | 'all')}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="priority">Priority</SelectItem>
                  <SelectItem value="dueDate">Due date</SelectItem>
                  <SelectItem value="createdAt">Created</SelectItem>
                </SelectContent>
              </Select>
            </>
          )}
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Task
        </Button>
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
        <div className="space-y-2">
          {filteredTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onToggleComplete={toggleComplete}
              onMoveToStatus={moveToStatus}
              onEdit={setEditingTask}
              onDelete={setDeleteTarget}
            />
          ))}
          {filteredTasks.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">
              No tasks match the current filters.
            </p>
          )}
        </div>
      ) : (
        <KanbanBoard
          tasks={tasks}
          onToggleComplete={toggleComplete}
          onMoveToStatus={moveToStatus}
          onEdit={setEditingTask}
          onDelete={setDeleteTarget}
        />
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
            setDeleteTarget(null)
          }
        }}
      />
    </div>
  )
}
