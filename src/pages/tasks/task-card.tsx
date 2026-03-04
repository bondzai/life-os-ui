import { forwardRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { PriorityBadge } from '@/core/components/priority-badge'
import type { Entity, EntityStatus } from '@/core/types'

const kanbanColumns: { status: EntityStatus; label: string }[] = [
  { status: 'active', label: 'Active' },
  { status: 'paused', label: 'Paused' },
  { status: 'completed', label: 'Completed' },
  { status: 'archived', label: 'Archived' },
]

export interface TaskCardProps {
  task: Entity
  showStatusMove?: boolean
  onToggleComplete: (task: Entity) => void
  onMoveToStatus: (task: Entity, status: EntityStatus) => void
  onEdit: (task: Entity) => void
  onDelete: (task: Entity) => void
  style?: React.CSSProperties
  className?: string
}

function isOverdue(task: Entity) {
  return task.dueDate && task.status !== 'completed' && task.dueDate < new Date().toISOString().split('T')[0]
}

const priorityBorder: Record<string, string> = {
  urgent: 'border-l-4 border-l-red-500',
  high: 'border-l-4 border-l-orange-500',
  medium: 'border-l-4 border-l-yellow-500',
  low: 'border-l-4 border-l-gray-300 dark:border-l-gray-600',
}

export const TaskCard = forwardRef<HTMLDivElement, TaskCardProps & React.HTMLAttributes<HTMLDivElement>>(
  ({ task, showStatusMove, onToggleComplete, onMoveToStatus, onEdit, onDelete, style, className, ...attrs }, ref) => (
    <Card ref={ref} style={style} className={`group ${priorityBorder[task.priority] || ''} ${className ?? ''}`} {...attrs}>
      <CardContent className="flex items-start gap-3 py-3">
        <Checkbox
          checked={task.status === 'completed'}
          onCheckedChange={() => onToggleComplete(task)}
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
            {Array.isArray(task.metadata.subtasks) && (task.metadata.subtasks as Array<{done: boolean}>).length > 0 && (() => {
              const subs = task.metadata.subtasks as Array<{done: boolean}>
              const done = subs.filter(s => s.done).length
              return (
                <span className="text-xs text-muted-foreground">
                  Subtasks: {done}/{subs.length}
                </span>
              )
            })()}
          </div>
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
                      onMoveToStatus(task, c.status)
                    }}
                  >
                    → {c.label}
                  </Button>
                ))}
            </div>
          )}
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onEdit(task)}>
            <span className="sr-only">Edit</span>✎
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onDelete(task)}>
            <span className="sr-only">Delete</span>×
          </Button>
        </div>
      </CardContent>
    </Card>
  ),
)

TaskCard.displayName = 'TaskCard'
