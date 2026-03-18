import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  Calendar,
  CheckSquare,
  Link,
  ListChecks,
  Plus,
  Search,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { isStory as checkIsStory, getSubtasks, isOverdue as checkIsOverdue, type Subtask } from './task-helpers'

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
  { value: 'active', label: 'TO DO' },
  { value: 'paused', label: 'IN PROGRESS' },
  { value: 'completed', label: 'DONE' },
]

const STATUS_COLORS: Record<EntityStatus, string> = {
  active: 'bg-blue-600 text-white',
  paused: 'bg-amber-500 text-white',
  completed: 'bg-green-600 text-white',
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

function resolveWorkspace(tags: string[]): 'work' | 'personal' | null {
  if (tags.includes('work')) return 'work'
  if (tags.includes('personal')) return 'personal'
  return null
}

/**
 * Derive parent task status from subtasks (Jira-like):
 * - All done → completed
 * - Some done → paused (in progress)
 * - None done → active (to do)
 * - Empty subtasks → no change (return null)
 */
function deriveStatusFromSubtasks(subtasks: Subtask[]): EntityStatus | null {
  if (subtasks.length === 0) return null
  const doneCount = subtasks.filter((s) => s.done).length
  if (doneCount === subtasks.length) return 'completed'
  if (doneCount > 0) return 'paused'
  return 'active'
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
      const subtasks = getSubtasks(task.metadata).map((s) =>
        s.id === subtaskId ? { ...s, done: !s.done } : s,
      )
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
      { id: crypto.randomUUID(), title, done: false },
    ]
    const derivedStatus = deriveStatusFromSubtasks(subtasks)
    onUpdate(task.id, {
      metadata: { ...task.metadata, subtasks },
      ...(derivedStatus ? { status: derivedStatus } : {}),
    })
    setNewSubtask('')
  }, [task, newSubtask, onUpdate])

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
  const doneCount = subtasks.filter((s) => s.done).length
  const isStory = checkIsStory(task)
  const workspace = resolveWorkspace(task.tags)
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
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Due Date
              </span>
              <Input
                type="date"
                value={task.dueDate ?? ''}
                onChange={(e) => handleDueDateChange(e.target.value)}
                className={`h-8 text-xs ${overdue ? 'text-destructive border-destructive' : ''}`}
              />
            </div>

            {/* Workspace */}
            {workspace && (
              <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                <span className="text-xs text-muted-foreground font-medium">Workspace</span>
                <Badge variant="outline" className="w-fit text-xs">
                  {workspace}
                </Badge>
              </div>
            )}

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

            {/* Subtask list */}
            {subtasks.length > 0 && (
              <div className="space-y-1">
                {subtasks.map((st) => (
                  <div key={st.id} className="flex items-center gap-2 group/st">
                    <Checkbox
                      checked={st.done}
                      onCheckedChange={() => handleSubtaskToggle(st.id)}
                    />
                    <span
                      className={`text-sm flex-1 ${
                        st.done ? 'line-through text-muted-foreground' : ''
                      }`}
                    >
                      {st.title}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover/st:opacity-100 transition-opacity"
                      onClick={() => handleSubtaskRemove(st.id)}
                    >
                      <X className="h-3 w-3" />
                      <span className="sr-only">Remove</span>
                    </Button>
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
