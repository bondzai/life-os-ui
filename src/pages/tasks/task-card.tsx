import { forwardRef, memo, useState, useMemo, useCallback } from 'react'
import {
  ListChecks,
  ChevronsUp,
  ArrowUp,
  ArrowRight,
  ArrowDown,
  Ban,
  Clock,
  Globe,
  Pencil,
  Trash2,
  Repeat,
  Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Entity, EntityStatus } from '@/core/types'
import { isStory as checkIsStory, getSubtasks, getSubtaskProgress, isOverdue as checkIsOverdue, formatShortDate, getRecurrence, subtaskStatus, subtaskDone } from './task-helpers'

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
  onMoveUnder?: (taskId: string, parentId: string) => void
  onToggleSubtask?: (taskId: string, subtaskId: string) => void
  allTasks?: Entity[]
  selected?: boolean
  onSelectTask?: (task: Entity, selected: boolean) => void
  blocked?: boolean
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
        onMoveUnder,
        onToggleSubtask,
        allTasks,
        selected,
        onSelectTask,
        blocked,
        style,
        className,
        ...attrs
      },
      ref,
    ) => {
      const subtaskProgress = getSubtaskProgress(task.metadata)
      const isStory = checkIsStory(task)
      const completed = task.status === 'done'
      const overdue = checkIsOverdue(task.dueDate, task.status)
      const visibleTags = task.tags.slice(0, 2)
      const extraTags = task.tags.length - 2
      const [expanded, setExpanded] = useState(false)
      const allSubs = useMemo(() => isStory ? getSubtasks(task.metadata) : [], [task.metadata, isStory])

      const handleClick = useCallback(() => {
        if (isStory && onToggleSubtask) {
          setExpanded((e) => !e)
        } else {
          onClick?.()
        }
      }, [isStory, onToggleSubtask, onClick])

      return (
        <div ref={ref} style={style} className={className}>
        <div
          className={`group flex items-center gap-2 px-2 py-1.5 border-b border-border hover:bg-muted/50 transition-colors cursor-pointer`}
          onClick={handleClick}
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
          {subtaskProgress ? (
            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border shrink-0 ${STATUS_STYLE[task.status] ?? ''}`}>
              {STATUS_SHORT[task.status] ?? task.status}
            </span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  onClick={(e) => e.stopPropagation()}
                  className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border shrink-0 transition-colors hover:opacity-80 cursor-pointer ${STATUS_STYLE[task.status] ?? ''}`}
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
          {subtaskProgress && (
            <div className="w-12 shrink-0 flex items-center gap-1" title={`${subtaskProgress.done}/${subtaskProgress.total}`}>
              <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${subtaskProgress.pct}%` }}
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

          {/* Shared indicator */}
          {task.visibility === 'shared' && (
            <span className="shrink-0" title="Shared">
              <Globe className="h-3 w-3 text-muted-foreground/50" />
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

          {/* Blocked indicator */}
          {blocked && (
            <span className="flex items-center gap-0.5 text-[10px] text-destructive font-medium shrink-0" title="Blocked">
              <Ban className="h-3 w-3" />
            </span>
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
            {onMoveUnder && allTasks && !isStory && (
              <MoveUnderPopover
                task={task}
                allTasks={allTasks}
                onMove={(parentId) => onMoveUnder(task.id, parentId)}
              />
            )}
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

        {/* Accordion subtasks */}
        {expanded && allSubs.length > 0 && (
          <div className="border-b border-border bg-muted/20 pl-8 pr-2 py-1">
            {allSubs.map((st) => {
              const status = subtaskStatus(st)
              const done = subtaskDone(st)
              return (
                <div key={st.id} className="flex items-center gap-2 py-1 group/st">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleSubtask?.(task.id, st.id)
                    }}
                    className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors ${
                      status === 'done'
                        ? 'bg-primary border-primary text-primary-foreground'
                        : status === 'in-progress'
                          ? 'border-amber-500 bg-amber-500/20'
                          : 'border-muted-foreground/30'
                    }`}
                  >
                    {status === 'done' && (
                      <svg className="h-2 w-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {status === 'in-progress' && <div className="h-1 w-1 rounded-full bg-amber-500" />}
                  </button>
                  <span className={`text-xs flex-1 truncate ${done ? 'line-through text-muted-foreground' : ''}`}>
                    {st.title}
                  </span>
                  {status === 'in-progress' && (
                    <span className="text-[9px] px-1 py-px rounded bg-amber-500/15 text-amber-500">WIP</span>
                  )}
                </div>
              )
            })}
            <button
              onClick={(e) => { e.stopPropagation(); onClick?.() }}
              className="text-[10px] text-muted-foreground/40 hover:text-primary transition-colors py-1 cursor-pointer"
            >
              Open detail
            </button>
          </div>
        )}
        </div>
      )
    },
  ),
)

TaskCard.displayName = 'TaskCard'

// ─── Move Under Popover ───

function MoveUnderPopover({ task, allTasks, onMove }: { task: Entity; allTasks: Entity[]; onMove: (parentId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const candidates = useMemo(() => {
    const filtered = allTasks.filter((e) =>
      e.id !== task.id &&
      e.status !== 'archived' &&
      e.status !== 'done',
    ).sort((a, b) => {
      const aHas = Array.isArray(a.metadata?.subtasks) && (a.metadata.subtasks as unknown[]).length > 0
      const bHas = Array.isArray(b.metadata?.subtasks) && (b.metadata.subtasks as unknown[]).length > 0
      if (aHas && !bHas) return -1
      if (!aHas && bHas) return 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
    if (!search.trim()) return filtered.slice(0, 10)
    const q = search.toLowerCase()
    return filtered.filter((e) => e.title.toLowerCase().includes(q)).slice(0, 10)
  }, [allTasks, task.id, search])

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setSearch('') }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={(e) => e.stopPropagation()}
          title="Move under..."
        >
          <ArrowRight className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="end" onClick={(e) => e.stopPropagation()}>
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="h-7 pl-7 text-xs"
            autoFocus
          />
        </div>
        <div className="max-h-[200px] overflow-y-auto space-y-0.5">
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2 text-center">No tasks found</p>
          ) : candidates.map((e) => {
            const hasSubs = Array.isArray(e.metadata?.subtasks) && (e.metadata.subtasks as unknown[]).length > 0
            return (
              <button
                key={e.id}
                onClick={() => { onMove(e.id); setOpen(false); setSearch('') }}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left text-xs hover:bg-accent transition-colors cursor-pointer"
              >
                {hasSubs && <ListChecks className="h-3 w-3 text-muted-foreground shrink-0" />}
                <span className="truncate flex-1">{e.title}</span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
