import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  Calendar,
  CheckSquare,
  Link,
  ListChecks,
  Pencil,
  Plus,
  Repeat,
  Search,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import type { Entity, EntityPriority, EntityStatus } from '@/core/types'
import { isStory as checkIsStory, getSubtasks, isOverdue as checkIsOverdue, subtaskStatus, subtaskDone, getRecurrence, RECURRENCE_OPTIONS, RECURRENCE_LABELS, type Subtask, type SubtaskStatus } from './task-helpers'

export interface TaskDetailPanelProps {
  task: Entity | null
  taskKey?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate: (id: string, updates: Partial<Entity>) => void
  onDelete: (task: Entity) => void
  /** All tasks — used to link existing tasks as subtasks */
  allTasks?: Entity[]
  /** Called when an existing task is linked as a subtask (should archive the original) */
  onLinkTask?: (parentId: string, childTask: Entity) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_WORKFLOW: { value: EntityStatus; label: string }[] = [
  { value: 'backlog', label: 'BACKLOG' },
  { value: 'todo', label: 'TO DO' },
  { value: 'in-progress', label: 'IN PROGRESS' },
  { value: 'done', label: 'DONE' },
]

const STATUS_COLORS: Record<EntityStatus, string> = {
  backlog: 'bg-gray-500 text-white',
  todo: 'bg-blue-600 text-white',
  'in-progress': 'bg-amber-500 text-white',
  done: 'bg-green-600 text-white',
  archived: 'bg-gray-500 text-white',
}

const PRIORITY_COLORS: Record<EntityPriority, string> = {
  urgent: 'text-red-500',
  high: 'text-orange-500',
  medium: 'text-yellow-500',
  low: 'text-gray-400',
}

const PRIORITY_DOT: Record<EntityPriority, string> = {
  urgent: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-gray-400',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDetailDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function resolveWorkspace(metadata: Record<string, unknown>): 'work' | 'personal' | null {
  const ws = metadata.workspace
  if (ws === 'work' || ws === 'personal') return ws
  return null
}

/**
 * Derive parent task status from subtasks (Jira-like):
 * - All done → done
 * - Some done → in-progress
 * - None done → no change
 * - Empty subtasks → no change (return null)
 */
function deriveStatusFromSubtasks(subtasks: Subtask[]): EntityStatus | null {
  if (subtasks.length === 0) return null
  const doneCount = subtasks.filter((s) => subtaskDone(s)).length
  if (doneCount === subtasks.length) return 'done'
  const hasInProgress = subtasks.some((s) => subtaskStatus(s) === 'in-progress')
  if (hasInProgress || doneCount > 0) return 'in-progress'
  return null // no change when all todo
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TaskDetailPanel({
  task,
  taskKey,
  open,
  onOpenChange,
  onUpdate,
  onDelete,
  allTasks = [],
  onLinkTask,
}: TaskDetailPanelProps) {
  // -- Local editing state --------------------------------------------------

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)

  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const descRef = useRef<HTMLTextAreaElement>(null)

  const [tagInput, setTagInput] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const [newSubtask, setNewSubtask] = useState('')
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null)
  const [subtaskDraft, setSubtaskDraft] = useState('')
  const subtaskEditRef = useRef<HTMLInputElement>(null)

  // Set parent (make this task a subtask of another)
  const [showParentSearch, setShowParentSearch] = useState(false)
  const [parentSearch, setParentSearch] = useState('')
  const parentInputRef = useRef<HTMLInputElement>(null)

  // Reset local state when task changes
  useEffect(() => {
    setEditingTitle(false)
    setEditingDesc(false)
    setConfirmDelete(false)
    setTagInput('')
    setNewSubtask('')
    setEditingSubtaskId(null)
    setSubtaskDraft('')
    setShowParentSearch(false)
    setParentSearch('')
  }, [task?.id])

  // Auto-focus title input
  useEffect(() => {
    if (editingTitle) titleRef.current?.focus()
  }, [editingTitle])

  // Auto-focus description textarea
  useEffect(() => {
    if (editingDesc) descRef.current?.focus()
  }, [editingDesc])

  // Auto-focus subtask edit input
  useEffect(() => {
    if (editingSubtaskId) subtaskEditRef.current?.focus()
  }, [editingSubtaskId])

  // Auto-focus parent search input
  useEffect(() => {
    if (showParentSearch) parentInputRef.current?.focus()
  }, [showParentSearch])

  // -- Callbacks ------------------------------------------------------------

  const commitTitle = useCallback(() => {
    if (!task) return
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== task.title) {
      onUpdate(task.id, { title: trimmed })
    }
    setEditingTitle(false)
  }, [task, titleDraft, onUpdate])

  const commitDesc = useCallback(() => {
    if (!task) return
    const trimmed = descDraft.trim()
    if (trimmed !== (task.description ?? '')) {
      onUpdate(task.id, { description: trimmed || undefined })
    }
    setEditingDesc(false)
  }, [task, descDraft, onUpdate])

  const handleStatusChange = useCallback(
    (status: EntityStatus) => {
      if (!task || task.status === status) return
      onUpdate(task.id, { status })
    },
    [task, onUpdate],
  )

  const handlePriorityChange = useCallback(
    (priority: EntityPriority) => {
      if (!task) return
      onUpdate(task.id, { priority })
    },
    [task, onUpdate],
  )

  const handleDueDateChange = useCallback(
    (value: string) => {
      if (!task) return
      onUpdate(task.id, { dueDate: value || undefined })
    },
    [task, onUpdate],
  )

  const addTag = useCallback(() => {
    if (!task) return
    const tag = tagInput.trim().toLowerCase()
    if (!tag || task.tags.includes(tag)) return
    onUpdate(task.id, { tags: [...task.tags, tag] })
    setTagInput('')
  }, [task, tagInput, onUpdate])

  const removeTag = useCallback(
    (tag: string) => {
      if (!task) return
      onUpdate(task.id, { tags: task.tags.filter((t) => t !== tag) })
    },
    [task, onUpdate],
  )

  const handleSubtaskToggle = useCallback(
    (subtaskId: string) => {
      if (!task) return
      const subtasks = getSubtasks(task.metadata).map((s) => {
        if (s.id !== subtaskId) return s
        // Cycle: todo → in-progress → done → todo
        const current = subtaskStatus(s)
        const next: SubtaskStatus = current === 'todo' ? 'in-progress' : current === 'in-progress' ? 'done' : 'todo'
        return { ...s, done: next === 'done', status: next }
      })
      const derivedStatus = deriveStatusFromSubtasks(subtasks)
      onUpdate(task.id, {
        metadata: { ...task.metadata, subtasks },
        ...(derivedStatus ? { status: derivedStatus } : {}),
      })
    },
    [task, onUpdate],
  )

  const handleSubtaskRemove = useCallback(
    (subtaskId: string) => {
      if (!task) return
      const subtasks = getSubtasks(task.metadata).filter((s) => s.id !== subtaskId)
      const derivedStatus = deriveStatusFromSubtasks(subtasks)
      onUpdate(task.id, {
        metadata: { ...task.metadata, subtasks },
        ...(derivedStatus ? { status: derivedStatus } : {}),
      })
    },
    [task, onUpdate],
  )

  const handleSubtaskAdd = useCallback(() => {
    if (!task) return
    const title = newSubtask.trim()
    if (!title) return
    const subtasks = [
      ...getSubtasks(task.metadata),
      { id: crypto.randomUUID(), title, done: false, status: 'todo' as SubtaskStatus },
    ]
    const derivedStatus = deriveStatusFromSubtasks(subtasks)
    onUpdate(task.id, {
      metadata: { ...task.metadata, subtasks },
      ...(derivedStatus ? { status: derivedStatus } : {}),
    })
    setNewSubtask('')
  }, [task, newSubtask, onUpdate])

  const handleSubtaskRename = useCallback(
    (subtaskId: string) => {
      if (!task) return
      const trimmed = subtaskDraft.trim()
      if (!trimmed) {
        setEditingSubtaskId(null)
        return
      }
      const subtasks = getSubtasks(task.metadata).map((s) =>
        s.id === subtaskId ? { ...s, title: trimmed } : s,
      )
      onUpdate(task.id, { metadata: { ...task.metadata, subtasks } })
      setEditingSubtaskId(null)
      setSubtaskDraft('')
    },
    [task, subtaskDraft, onUpdate],
  )

  const handleSubtaskReorder = useCallback(
    (index: number, dir: -1 | 1) => {
      if (!task) return
      const subtasks = getSubtasks(task.metadata)
      const newIndex = index + dir
      if (newIndex < 0 || newIndex >= subtasks.length) return
      const updated = [...subtasks]
      const [moved] = updated.splice(index, 1)
      updated.splice(newIndex, 0, moved)
      onUpdate(task.id, { metadata: { ...task.metadata, subtasks: updated } })
    },
    [task, onUpdate],
  )

  const handleSetParent = useCallback(
    (parentTask: Entity) => {
      if (!task || !onLinkTask) return
      // onLinkTask(parentId, childTask) — this task becomes a subtask of parentTask
      onLinkTask(parentTask.id, task)
      setParentSearch('')
      setShowParentSearch(false)
    },
    [task, onLinkTask],
  )

  // Can this task be assigned as a subtask? Not if it has subtasks itself (stories can't nest)
  const hasSubtasks = task ? getSubtasks(task.metadata).length > 0 || !!task.metadata.isStory : false
  const canSetParent = !hasSubtasks

  // Potential parent tasks: same workspace, not this task, not archived
  const parentCandidates = task
    ? allTasks.filter((t) => {
        if (t.id === task.id) return false
        if (t.status === 'archived') return false
        // Workspace must match — work stays in work, personal stays in personal
        const taskWs = task.metadata.workspace as string | undefined
        const candidateWs = t.metadata.workspace as string | undefined
        if (taskWs && candidateWs && taskWs !== candidateWs) return false
        if (taskWs && !candidateWs) return false
        if (!taskWs && candidateWs) return false
        // Search filter
        if (parentSearch && !t.title.toLowerCase().includes(parentSearch.toLowerCase())) return false
        return true
      })
    : []

  const handleArchive = useCallback(() => {
    if (!task) return
    onUpdate(task.id, { status: 'archived' })
  }, [task, onUpdate])

  const handleDelete = useCallback(() => {
    if (!task) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    onDelete(task)
    onOpenChange(false)
  }, [task, confirmDelete, onDelete, onOpenChange])

  // -- Guard ----------------------------------------------------------------

  if (!task) return null

  const subtasks = getSubtasks(task.metadata)
  const doneCount = subtasks.filter((s) => subtaskDone(s)).length
  const isStory = checkIsStory(task)
  const workspace = resolveWorkspace(task.metadata)
  const overdue = checkIsOverdue(task.dueDate, task.status)

  // -- Render ---------------------------------------------------------------

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="sm:max-w-lg w-full flex flex-col overflow-y-auto p-0"
      >
        {/* Header */}
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b px-5 py-3">
          <div className="flex items-center gap-2">
            {isStory ? (
              <ListChecks className="h-4 w-4 text-muted-foreground" />
            ) : (
              <CheckSquare className="h-4 w-4 text-muted-foreground" />
            )}
            {taskKey && (
              <span className="font-mono text-xs text-muted-foreground">
                {taskKey}
              </span>
            )}
          </div>
          <SheetTitle className="sr-only">Task Detail</SheetTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Button>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {/* Title */}
          <div className="px-5 pt-4 pb-2">
            {editingTitle ? (
              <Input
                ref={titleRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTitle()
                  if (e.key === 'Escape') setEditingTitle(false)
                }}
                className="text-lg font-semibold h-auto py-1"
              />
            ) : (
              <h2
                className="text-lg font-semibold cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1 py-0.5 transition-colors"
                onClick={() => {
                  setTitleDraft(task.title)
                  setEditingTitle(true)
                }}
              >
                {task.title}
              </h2>
            )}
          </div>

          {/* Status workflow bar */}
          <div className="px-5 pb-4">
            {hasSubtasks && (
              <p className="text-[10px] text-muted-foreground mb-1">Status is driven by subtasks</p>
            )}
            <div className="flex rounded-md border overflow-hidden">
              {STATUS_WORKFLOW.map((s) => (
                <button
                  key={s.value}
                  onClick={() => !hasSubtasks && handleStatusChange(s.value)}
                  disabled={hasSubtasks}
                  className={`flex-1 text-xs font-medium py-1.5 transition-colors ${
                    task.status === s.value
                      ? STATUS_COLORS[s.value]
                      : 'bg-muted/40 text-muted-foreground hover:bg-muted'
                  } ${hasSubtasks ? 'cursor-not-allowed opacity-80' : ''}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Fields grid */}
          <div className="px-5 pb-4 space-y-3">
            {/* Priority */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium">Priority</span>
              <Select
                value={task.priority}
                onValueChange={(v) => handlePriorityChange(v as EntityPriority)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['urgent', 'high', 'medium', 'low'] as EntityPriority[]).map(
                    (p) => (
                      <SelectItem key={p} value={p}>
                        <span className="flex items-center gap-2">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${PRIORITY_DOT[p]}`}
                          />
                          <span className={PRIORITY_COLORS[p]}>
                            {p.charAt(0).toUpperCase() + p.slice(1)}
                          </span>
                        </span>
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Due date */}
            <div className="grid grid-cols-[120px_1fr] items-start gap-2">
              <span className="text-xs text-muted-foreground font-medium flex items-center gap-1 pt-1.5">
                <Calendar className="h-3 w-3" />
                Due Date
              </span>
              <div className="space-y-1.5">
                <Input
                  type="date"
                  value={task.dueDate ?? ''}
                  onChange={(e) => handleDueDateChange(e.target.value)}
                  className={`h-8 text-xs ${overdue ? 'text-destructive border-destructive' : ''}`}
                />
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: 'Today', days: 0 },
                    { label: 'Tomorrow', days: 1 },
                    { label: 'Next week', days: 7 },
                    { label: 'None', days: -1 },
                  ].map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
                      onClick={() => {
                        if (opt.days === -1) {
                          handleDueDateChange('')
                        } else {
                          const d = new Date()
                          d.setDate(d.getDate() + opt.days)
                          handleDueDateChange(d.toISOString().split('T')[0])
                        }
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Recurrence */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                <Repeat className="h-3 w-3" />
                Repeat
              </span>
              <Select
                value={getRecurrence(task.metadata)}
                onValueChange={(v) => {
                  if (!task) return
                  onUpdate(task.id, {
                    metadata: {
                      ...task.metadata,
                      recurring: v === 'none' ? undefined : v,
                    },
                  })
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRENCE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {RECURRENCE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Story points */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium">Estimate</span>
              <Select
                value={String(task.metadata.points ?? 'none')}
                onValueChange={(v) => {
                  if (!task) return
                  onUpdate(task.id, {
                    metadata: {
                      ...task.metadata,
                      points: v === 'none' ? undefined : Number(v),
                    },
                  })
                }}
              >
                <SelectTrigger className="h-8 text-xs w-40">
                  <SelectValue placeholder="No estimate" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No estimate</SelectItem>
                  {[1, 2, 3, 5, 8, 13].map((pt) => (
                    <SelectItem key={pt} value={String(pt)}>
                      {pt} {pt === 1 ? 'point' : 'points'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Workspace */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium">Workspace</span>
              <Select
                value={workspace ?? 'none'}
                onValueChange={(v) => {
                  if (!task) return
                  onUpdate(task.id, {
                    metadata: {
                      ...task.metadata,
                      workspace: v === 'none' ? undefined : v,
                    },
                  })
                }}
              >
                <SelectTrigger className="h-8 text-xs w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No workspace</SelectItem>
                  <SelectItem value="work">Work</SelectItem>
                  <SelectItem value="personal">Personal</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Parent — set this task as subtask of another (hidden for stories) */}
            {onLinkTask && canSetParent && (
              <div className="grid grid-cols-[120px_1fr] items-start gap-2">
                <span className="text-xs text-muted-foreground font-medium flex items-center gap-1 pt-1">
                  <Link className="h-3 w-3" />
                  Parent
                </span>
                <div>
                  {showParentSearch ? (
                    <div className="space-y-1">
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          ref={parentInputRef}
                          placeholder="Search tasks..."
                          value={parentSearch}
                          onChange={(e) => setParentSearch(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              setShowParentSearch(false)
                              setParentSearch('')
                            }
                          }}
                          className="h-7 text-xs pl-7"
                        />
                      </div>
                      {parentCandidates.length > 0 ? (
                        <div className="max-h-36 overflow-y-auto rounded-md border">
                          {parentCandidates.slice(0, 8).map((t) => {
                            const tIsStory = checkIsStory(t)
                            return (
                              <button
                                key={t.id}
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors flex items-center gap-2 border-b last:border-b-0"
                                onClick={() => handleSetParent(t)}
                              >
                                {tIsStory ? (
                                  <ListChecks className="h-3 w-3 text-muted-foreground shrink-0" />
                                ) : (
                                  <CheckSquare className="h-3 w-3 text-muted-foreground shrink-0" />
                                )}
                                <span className="truncate">{t.title}</span>
                              </button>
                            )
                          })}
                        </div>
                      ) : parentSearch ? (
                        <p className="text-[11px] text-muted-foreground py-1">No matching tasks</p>
                      ) : null}
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground gap-1.5"
                      onClick={() => setShowParentSearch(true)}
                    >
                      Set parent task
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Tags */}
            <div className="grid grid-cols-[120px_1fr] items-start gap-2">
              <span className="text-xs text-muted-foreground font-medium flex items-center gap-1 pt-1">
                <Tag className="h-3 w-3" />
                Tags
              </span>
              <div className="space-y-1.5">
                <div className="flex flex-wrap gap-1">
                  {task.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="text-xs gap-1 pr-1"
                    >
                      {tag}
                      <button
                        onClick={() => removeTag(tag)}
                        className="hover:text-destructive transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                  {task.tags.length === 0 && (
                    <span className="text-xs text-muted-foreground">No tags</span>
                  )}
                </div>
                <div className="flex gap-1">
                  <Input
                    placeholder="Add tag..."
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addTag()
                      }
                    }}
                    className="h-7 text-xs"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 shrink-0"
                    onClick={addTag}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Created / Updated */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium">Created</span>
              <span className="text-xs text-muted-foreground">
                {formatDetailDate(task.createdAt)}
              </span>
            </div>
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium">Updated</span>
              <span className="text-xs text-muted-foreground">
                {formatDetailDate(task.updatedAt)}
              </span>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t mx-5" />

          {/* Description */}
          <div className="px-5 py-4">
            <h3 className="text-xs font-medium text-muted-foreground mb-2">
              Description
            </h3>
            {editingDesc ? (
              <Textarea
                ref={descRef}
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={commitDesc}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingDesc(false)
                }}
                rows={4}
                className="text-sm resize-none"
              />
            ) : (
              <div
                className="text-sm whitespace-pre-wrap cursor-pointer rounded px-1 -mx-1 py-1 hover:bg-muted/50 transition-colors min-h-[2rem]"
                onClick={() => {
                  setDescDraft(task.description ?? '')
                  setEditingDesc(true)
                }}
              >
                {task.description || (
                  <span className="text-muted-foreground italic">
                    Add a description...
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Subtasks — always visible so any task can become a story */}
          <div className="border-t mx-5" />
          <div className="px-5 py-4">
            <h3 className="text-xs font-medium text-muted-foreground mb-2">
              Subtasks
              {subtasks.length > 0 && (
                <span className="ml-1.5">
                  ({doneCount}/{subtasks.length})
                </span>
              )}
            </h3>

            {/* Progress bar */}
            {subtasks.length > 0 && (
              <div className="h-1.5 bg-muted rounded-full overflow-hidden mb-3">
                <div
                  className="h-full bg-green-500 transition-all duration-300"
                  style={{
                    width: `${(doneCount / subtasks.length) * 100}%`,
                  }}
                />
              </div>
            )}

            {/* Subtask list — Jira-style rows */}
            {subtasks.length > 0 && (
              <div className="rounded-md border divide-y">
                {subtasks.map((st, i) => (
                  <div
                    key={st.id}
                    className="flex items-center gap-2 px-2 py-1.5 group/st hover:bg-muted/50 transition-colors"
                  >
                    {/* Reorder buttons */}
                    <div className="flex flex-col shrink-0 opacity-0 group-hover/st:opacity-100 transition-opacity">
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground text-[10px] leading-none h-3 disabled:opacity-20"
                        onClick={() => handleSubtaskReorder(i, -1)}
                        disabled={i === 0}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground text-[10px] leading-none h-3 disabled:opacity-20"
                        onClick={() => handleSubtaskReorder(i, 1)}
                        disabled={i === subtasks.length - 1}
                      >
                        ▼
                      </button>
                    </div>

                    {/* Status toggle — cycles todo → in-progress → done */}
                    <button
                      onClick={() => handleSubtaskToggle(st.id)}
                      className={`h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors ${
                        subtaskStatus(st) === 'done'
                          ? 'bg-primary border-primary text-primary-foreground'
                          : subtaskStatus(st) === 'in-progress'
                            ? 'border-amber-500 bg-amber-500/20'
                            : 'border-muted-foreground/30'
                      }`}
                      title={`Status: ${subtaskStatus(st)} — click to cycle`}
                    >
                      {subtaskStatus(st) === 'done' && (
                        <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      {subtaskStatus(st) === 'in-progress' && (
                        <div className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                      )}
                    </button>

                    {/* Title — inline editable */}
                    {editingSubtaskId === st.id ? (
                      <Input
                        ref={subtaskEditRef}
                        value={subtaskDraft}
                        onChange={(e) => setSubtaskDraft(e.target.value)}
                        onBlur={() => handleSubtaskRename(st.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSubtaskRename(st.id)
                          if (e.key === 'Escape') {
                            setEditingSubtaskId(null)
                            setSubtaskDraft('')
                          }
                        }}
                        className="h-6 text-sm flex-1 py-0"
                      />
                    ) : (
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        {subtaskStatus(st) === 'in-progress' && (
                          <span className="text-[9px] font-medium px-1 py-px rounded bg-amber-500/15 text-amber-500 shrink-0">WIP</span>
                        )}
                        <span
                          className={`text-sm truncate cursor-pointer rounded px-1 -mx-1 hover:bg-muted transition-colors ${
                            subtaskDone(st) ? 'line-through text-muted-foreground' : ''
                          }`}
                          onClick={() => {
                            setSubtaskDraft(st.title)
                            setEditingSubtaskId(st.id)
                          }}
                        >
                          {st.title}
                        </span>
                      </div>
                    )}

                    {/* Status badge */}
                    <Badge
                      variant="outline"
                      className={`text-[10px] shrink-0 px-1.5 py-0 ${
                        st.done ? 'border-green-500 text-green-600' : 'border-blue-400 text-blue-500'
                      }`}
                    >
                      {st.done ? 'DONE' : 'TO DO'}
                    </Badge>

                    {/* Actions */}
                    <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/st:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => {
                          setSubtaskDraft(st.title)
                          setEditingSubtaskId(st.id)
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                        <span className="sr-only">Edit</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 hover:text-destructive"
                        onClick={() => handleSubtaskRemove(st.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                        <span className="sr-only">Remove</span>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add subtask */}
            <div className="flex gap-1 mt-2">
              <Input
                placeholder="Add subtask..."
                value={newSubtask}
                onChange={(e) => setNewSubtask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleSubtaskAdd()
                  }
                }}
                className="h-7 text-xs"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 shrink-0"
                onClick={handleSubtaskAdd}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>

          </div>
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-3 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={handleArchive}
            disabled={task.status === 'archived'}
          >
            <Archive className="h-3.5 w-3.5" />
            Archive
          </Button>
          <Button
            variant={confirmDelete ? 'destructive' : 'outline'}
            size="sm"
            className="gap-1.5 text-xs ml-auto"
            onClick={handleDelete}
            onBlur={() => setConfirmDelete(false)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {confirmDelete ? 'Confirm Delete' : 'Delete'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
