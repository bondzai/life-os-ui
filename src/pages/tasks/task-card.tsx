import { forwardRef, memo } from 'react'
import {
  ListChecks,
  ChevronsUp,
  ArrowUp,
  ArrowRight,
  ArrowDown,
  Clock,
  Pencil,
  Trash2,
  Repeat,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Entity, EntityStatus } from '@/core/types'
import { isStory as checkIsStory, getSubtaskProgress, isOverdue as checkIsOverdue, formatShortDate, getRecurrence } from './task-helpers'

export interface TaskCardProps {
  task: Entity
  taskKey?: string
  assignee?: string
  onClick?: () => void
  onToggleComplete: (task: Entity) => void
  onMoveToStatus: (task: Entity, status: EntityStatus) => void
  onEdit: (task: Entity) => void
  onDelete: (task: Entity) => void
  onSnooze?: (task: Entity, days: number) => void
  selected?: boolean
  onSelectTask?: (task: Entity, selected: boolean) => void
  style?: React.CSSProperties
  className?: string
}

function PriorityIcon({ priority }: { priority: string }) {
  switch (priority) {
    case 'urgent':
      return <ChevronsUp className="h-3.5 w-3.5 text-red-500 shrink-0" />
    case 'high':
      return <ArrowUp className="h-3.5 w-3.5 text-orange-500 shrink-0" />
    case 'medium':
      return <ArrowRight className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
    case 'low':
      return <ArrowDown className="h-3.5 w-3.5 text-blue-400 shrink-0" />
    default:
      return null
  }
}

const STATUS_OPTIONS: { value: EntityStatus; label: string }[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'To Do' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
]
const STATUS_STYLE: Record<string, string> = {
  backlog: 'bg-gray-400/20 text-gray-500 border-gray-400/30',
  todo: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30',
  'in-progress': 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  done: 'bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30',
}
const STATUS_SHORT: Record<string, string> = {
  backlog: 'BL',
  todo: 'TD',
  'in-progress': 'IP',
  done: '✓',
}
const STATUS_DOT: Record<string, string> = {
  backlog: 'bg-gray-400',
  todo: 'bg-blue-500',
  'in-progress': 'bg-amber-500',
  done: 'bg-green-500',
}

function InitialsAvatar({ name }: { name?: string }) {
  const letter = name ? name.charAt(0).toUpperCase() : '?'
  return (
    <div className="h-5 w-5 rounded-full bg-muted text-[10px] font-medium flex items-center justify-center shrink-0 text-muted-foreground">
      {letter}
    </div>
  )
}

export const TaskCard = memo(
  forwardRef<HTMLDivElement, TaskCardProps & React.HTMLAttributes<HTMLDivElement>>(
    (
      {
        task,
        taskKey,
        assignee,
        onClick,
        onToggleComplete: _onToggleComplete,
        onMoveToStatus,
        onEdit,
        onDelete,
        onSnooze,
        selected,
        onSelectTask,
        style,
        className,
        ...attrs
      },
      ref,
    ) => {
      const subtasks = getSubtaskProgress(task.metadata)
      const isStory = checkIsStory(task)
      const completed = task.status === 'done'
      const overdue = checkIsOverdue(task.dueDate, task.status)
      const visibleTags = task.tags.slice(0, 2)
      const extraTags = task.tags.length - 2

      return (
        <div
          ref={ref}
          style={style}
          className={`group flex items-center gap-2 px-2 py-1.5 border-b border-border hover:bg-muted/50 transition-colors cursor-pointer ${className ?? ''}`}
          onClick={onClick}
          {...attrs}
        >
          {/* Select checkbox */}
          {onSelectTask && (
            <Checkbox
              checked={selected ?? false}
              onCheckedChange={(checked) => onSelectTask(task, !!checked)}
              className="shrink-0"
              onClick={(e) => e.stopPropagation()}
            />
          )}

          {/* Status badge — dropdown for simple tasks, static for stories */}
          {subtasks ? (
            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border shrink-0 ${STATUS_STYLE[task.status] ?? ''}`}>
              {STATUS_SHORT[task.status] ?? task.status}
            </span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  onClick={(e) => e.stopPropagation()}
                  className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border shrink-0 transition-colors hover:opacity-80 ${STATUS_STYLE[task.status] ?? ''}`}
                >
                  {STATUS_SHORT[task.status] ?? task.status}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
                {STATUS_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    disabled={opt.value === task.status}
                    onClick={() => onMoveToStatus(task, opt.value)}
                    className="gap-2"
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[opt.value]}`} />
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Type icon */}
          {isStory && (
            <ListChecks className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}

          {/* Task key */}
          {taskKey && (
            <span className="text-xs font-mono text-muted-foreground shrink-0">{taskKey}</span>
          )}

          {/* Title */}
          <span
            className={`text-sm truncate min-w-0 flex-1 ${completed ? 'line-through text-muted-foreground' : ''}`}
          >
            {task.title}
          </span>

          {/* Subtask progress bar */}
          {subtasks && (
            <div className="w-12 shrink-0 flex items-center gap-1" title={`${subtasks.done}/${subtasks.total}`}>
              <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${subtasks.pct}%` }}
                />
              </div>
            </div>
          )}

          {/* Workspace badge */}
          {typeof task.metadata.workspace === 'string' && (
            <span
              className={`text-[10px] leading-tight px-1.5 py-0.5 rounded-full shrink-0 font-medium ${
                task.metadata.workspace === 'work'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              }`}
            >
              {task.metadata.workspace === 'work' ? 'Work' : 'Personal'}
            </span>
          )}

          {/* Tags */}
          {visibleTags.length > 0 && (
            <div className="flex items-center gap-1 shrink-0">
              {visibleTags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] leading-tight bg-secondary px-1.5 py-0.5 rounded-full text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
              {extraTags > 0 && (
                <span className="text-[10px] text-muted-foreground">+{extraTags}</span>
              )}
            </div>
          )}

          {/* Story points */}
          {typeof task.metadata.points === 'number' && (
            <span className="text-[10px] leading-tight bg-muted px-1.5 py-0.5 rounded font-mono text-muted-foreground shrink-0">
              {task.metadata.points}pt
            </span>
          )}

          {/* Priority icon */}
          <PriorityIcon priority={task.priority} />

          {/* Recurrence indicator */}
          {getRecurrence(task.metadata) !== 'none' && (
            <Repeat className="h-3 w-3 text-muted-foreground/50 shrink-0" />
          )}

          {/* Due date */}
          {task.dueDate && (
            <span
              className={`text-xs whitespace-nowrap shrink-0 ${overdue ? 'text-destructive font-medium' : 'text-muted-foreground'}`}
            >
              {formatShortDate(task.dueDate)}
            </span>
          )}

          {/* Assignee */}
          <InitialsAvatar name={assignee} />

          {/* Hover actions */}
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            {onSnooze && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="sr-only">Snooze</span>
                    <Clock className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation()
                      onSnooze(task, 1)
                    }}
                  >
                    Snooze 1 day
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation()
                      onSnooze(task, 7)
                    }}
                  >
                    Snooze 1 week
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={(e) => {
                e.stopPropagation()
                onEdit(task)
              }}
            >
              <span className="sr-only">Edit</span>
              <Pencil className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(task)
              }}
            >
              <span className="sr-only">Delete</span>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )
    },
  ),
)

TaskCard.displayName = 'TaskCard'
