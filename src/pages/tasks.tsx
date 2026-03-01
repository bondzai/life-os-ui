import { useState, useMemo } from 'react'
import { Plus, CheckSquare, List, Columns3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import { PriorityBadge } from '@/core/components/priority-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'

type SortKey = 'priority' | 'dueDate' | 'createdAt'
type ViewMode = 'list' | 'kanban'

const priorityOrder: Record<EntityPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const kanbanColumns: { status: EntityStatus; label: string }[] = [
  { status: 'active', label: 'Active' },
  { status: 'paused', label: 'Paused' },
  { status: 'completed', label: 'Completed' },
  { status: 'archived', label: 'Archived' },
]

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

  const isOverdue = (task: Entity) =>
    task.dueDate && task.status !== 'completed' && task.dueDate < new Date().toISOString().split('T')[0]

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  const TaskCard = ({ task, showStatusMove }: { task: Entity; showStatusMove?: boolean }) => (
    <Card className="group">
      <CardContent className="flex items-start gap-3 py-3">
        <Checkbox
          checked={task.status === 'completed'}
          onCheckedChange={() => toggleComplete(task)}
          className="mt-0.5"
        />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <span className={`text-sm font-medium ${task.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>
              {task.title}
            </span>
            <div className="flex gap-1 shrink-0">
              <PriorityBadge priority={task.priority} />
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {task.dueDate && (
              <span className={`text-xs ${isOverdue(task) ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                {isOverdue(task) ? 'Overdue: ' : 'Due: '}
                {new Date(task.dueDate).toLocaleDateString()}
              </span>
            )}
            {task.tags.map((tag) => (
              <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">{tag}</span>
            ))}
          </div>
          {/* Quick actions */}
          {showStatusMove && (
            <div className="flex gap-1 pt-1">
              {kanbanColumns
                .filter((c) => c.status !== task.status)
                .map((c) => (
                  <Button
                    key={c.status}
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={(e) => {
                      e.stopPropagation()
                      moveToStatus(task, c.status)
                    }}
                  >
                    → {c.label}
                  </Button>
                ))}
            </div>
          )}
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditingTask(task)}>
            <span className="sr-only">Edit</span>✎
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setDeleteTarget(task)}>
            <span className="sr-only">Delete</span>×
          </Button>
        </div>
      </CardContent>
    </Card>
  )

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
            <TaskCard key={task.id} task={task} />
          ))}
          {filteredTasks.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">
              No tasks match the current filters.
            </p>
          )}
        </div>
      ) : (
        /* Kanban view */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {kanbanColumns.map((col) => {
            const columnTasks = tasks.filter((t) => t.status === col.status)
            return (
              <div key={col.status} className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <h3 className="text-sm font-medium">
                    {col.label}
                    <span className="ml-1.5 text-xs text-muted-foreground">({columnTasks.length})</span>
                  </h3>
                </div>
                <div className="space-y-2 min-h-[100px] rounded-lg border border-dashed p-2">
                  {columnTasks.map((task) => (
                    <TaskCard key={task.id} task={task} showStatusMove />
                  ))}
                  {columnTasks.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">No tasks</p>
                  )}
                </div>
              </div>
            )
          })}
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
            setDeleteTarget(null)
          }
        }}
      />
    </div>
  )
}
