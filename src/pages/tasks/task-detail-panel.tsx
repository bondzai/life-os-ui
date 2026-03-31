import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Calendar,
  CheckSquare,
  ChevronsUp,
  ChevronRight,
  FolderKanban,
  GripVertical,
  History,
  Link,
  ListChecks,
  MessageSquare,
  Minus,
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { Entity, EntityPriority, EntityStatus, Relation } from '@/core/types'
import { isGoal } from '@/core/types'
import { useEntities, useRelations } from '@/core/hooks'
import { AIAction } from '@/components/ai-action'
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
  /** Called when a subtask is promoted to a standalone task */
  onPromoteSubtask?: (parentId: string, subtask: Subtask) => void
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

const SUBTASK_PRIORITY_ORDER: ('urgent' | 'high' | 'medium' | 'low')[] = ['medium', 'low', 'urgent', 'high']

function SubtaskPriorityIcon({ priority, size = 12 }: { priority?: 'urgent' | 'high' | 'medium' | 'low'; size?: number }) {
  const p = priority ?? 'medium'
  switch (p) {
    case 'urgent': return <ChevronsUp style={{ width: size, height: size }} className="text-red-500" />
    case 'high': return <ArrowUp style={{ width: size, height: size }} className="text-orange-500" />
    case 'medium': return <Minus style={{ width: size, height: size }} className="text-yellow-500" />
    case 'low': return <ArrowDown style={{ width: size, height: size }} className="text-blue-400" />
  }
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

// Activity timeline
interface ActivityEntry {
  id: string
  action: string
  timestamp: string
}

function getActivity(metadata: Record<string, unknown>): ActivityEntry[] {
  return Array.isArray(metadata.activity) ? (metadata.activity as ActivityEntry[]) : []
}

function addActivity(metadata: Record<string, unknown>, action: string): Record<string, unknown> {
  const entries = getActivity(metadata)
  const entry: ActivityEntry = { id: crypto.randomUUID(), action, timestamp: new Date().toISOString() }
  return { ...metadata, activity: [entry, ...entries].slice(0, 50) }
}

// Task notes
interface TaskNote {
  id: string
  text: string
  timestamp: string
}

function getNotes(metadata: Record<string, unknown>): TaskNote[] {
  return Array.isArray(metadata.notes) ? (metadata.notes as TaskNote[]) : []
}

function addNote(metadata: Record<string, unknown>, text: string): Record<string, unknown> {
  const notes = getNotes(metadata)
  const note: TaskNote = { id: crypto.randomUUID(), text, timestamp: new Date().toISOString() }
  return { ...metadata, notes: [note, ...notes] }
}

function updateNoteText(metadata: Record<string, unknown>, noteId: string, text: string): Record<string, unknown> {
  const notes = getNotes(metadata).map((n) => n.id === noteId ? { ...n, text } : n)
  return { ...metadata, notes }
}

function removeNote(metadata: Record<string, unknown>, noteId: string): Record<string, unknown> {
  const notes = getNotes(metadata).filter((n) => n.id !== noteId)
  return { ...metadata, notes: notes.length > 0 ? notes : undefined }
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return formatDetailDate(iso)
}

// Pretty JSON renderer for structured notes
const NOTE_STATUS_BADGE: Record<string, string> = {
  open: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
  in_progress: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  pending: 'bg-violet-500/15 text-violet-600 border-violet-500/30',
  resolved: 'bg-green-500/15 text-green-600 border-green-500/30',
  closed: 'bg-zinc-500/15 text-zinc-500 border-zinc-500/30',
  done: 'bg-green-500/15 text-green-600 border-green-500/30',
  todo: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
}

function NoteJsonView({ data }: { data: unknown }) {
  if (Array.isArray(data)) {
    return (
      <div className="space-y-1">
        {data.map((item, i) => (
          <div key={i} className="pl-2 border-l-2 border-border/50">
            {typeof item === 'object' && item !== null ? <NoteJsonView data={item} /> : (
              <span className="text-foreground/80">{String(item)}</span>
            )}
          </div>
        ))}
      </div>
    )
  }

  if (typeof data === 'object' && data !== null) {
    const entries = Object.entries(data as Record<string, unknown>)
    return (
      <div className="space-y-1">
        {entries.map(([key, value]) => {
          // Status fields — render as badge
          if ((key === 'status' || key.endsWith('_status')) && typeof value === 'string') {
            const style = NOTE_STATUS_BADGE[value] ?? 'bg-muted text-muted-foreground'
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="text-muted-foreground/60 w-24 shrink-0 truncate">{key}</span>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${style}`}>
                  {value.replace(/_/g, ' ')}
                </span>
              </div>
            )
          }
          // Timestamp fields
          if ((key.endsWith('_at') || key === 'timestamp' || key === 'created_at' || key === 'resolved_at') && typeof value === 'string' && !isNaN(Date.parse(value))) {
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="text-muted-foreground/60 w-24 shrink-0 truncate">{key}</span>
                <span className="text-foreground/70 tabular-nums">{new Date(value).toLocaleString()}</span>
              </div>
            )
          }
          // Null values
          if (value === null || value === undefined) {
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="text-muted-foreground/60 w-24 shrink-0 truncate">{key}</span>
                <span className="text-muted-foreground/30 italic">—</span>
              </div>
            )
          }
          // Nested objects
          if (typeof value === 'object') {
            return (
              <div key={key}>
                <span className="text-muted-foreground/60">{key}</span>
                <div className="pl-3 mt-0.5 border-l-2 border-border/50">
                  <NoteJsonView data={value} />
                </div>
              </div>
            )
          }
          // String/number — key: value row
          return (
            <div key={key} className="flex items-baseline gap-2">
              <span className="text-muted-foreground/60 w-24 shrink-0 truncate">{key}</span>
              <span className="text-foreground/80 break-words min-w-0">{String(value)}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return <span className="text-foreground/80">{String(data)}</span>
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

// ---------------------------------------------------------------------------
// Sortable subtask row
// ---------------------------------------------------------------------------

interface SortableSubtaskProps {
  st: Subtask
  onToggle: (id: string) => void
  onRemove: (id: string) => void
  onStartEdit: (st: Subtask) => void
  isEditing: boolean
  editDraft: string
  onEditDraftChange: (val: string) => void
  onEditCommit: (id: string) => void
  onEditCancel: () => void
  editRef: React.RefObject<HTMLInputElement | null>
  onAddNote: (subtaskId: string, text: string) => void
  onRemoveNote: (subtaskId: string, noteId: string) => void
  onEditNote: (subtaskId: string, noteId: string, text: string) => void
  onCyclePriority: (subtaskId: string) => void
  onPromote?: (subtaskId: string) => void
}

function SortableSubtaskRow({
  st,
  onToggle,
  onRemove,
  onStartEdit,
  isEditing,
  editDraft,
  onEditDraftChange,
  onEditCommit,
  onEditCancel,
  editRef,
  onAddNote,
  onRemoveNote,
  onEditNote,
  onCyclePriority,
  onPromote,
}: SortableSubtaskProps) {
  const [showNotes, setShowNotes] = useState(false)
  const [noteVal, setNoteVal] = useState('')
  const [editSubNoteId, setEditSubNoteId] = useState<string | null>(null)
  const [editSubNoteDraft, setEditSubNoteDraft] = useState('')
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: st.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : undefined,
  }

  const status = subtaskStatus(st)

  return (
    <div ref={setNodeRef} style={style} className="group/st hover:bg-muted/50 transition-colors bg-background">
      <div className="flex items-center gap-2 px-2 py-1.5">
      {/* Drag handle */}
      <button
        type="button"
        className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground touch-none"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      {/* Status toggle */}
      <button
        onClick={() => onToggle(st.id)}
        className={`h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors ${
          status === 'done'
            ? 'bg-primary border-primary text-primary-foreground'
            : status === 'in-progress'
              ? 'border-amber-500 bg-amber-500/20'
              : 'border-muted-foreground/30'
        }`}
        title={`Status: ${status} — click to cycle`}
      >
        {status === 'done' && (
          <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
        {status === 'in-progress' && (
          <div className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        )}
      </button>

      {/* Title — inline editable */}
      {isEditing ? (
        <Input
          ref={editRef}
          value={editDraft}
          onChange={(e) => onEditDraftChange(e.target.value)}
          onBlur={() => onEditCommit(st.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEditCommit(st.id)
            if (e.key === 'Escape') onEditCancel()
          }}
          className="h-6 text-sm flex-1 py-0"
        />
      ) : (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {status === 'in-progress' && (
            <span className="text-[9px] font-medium px-1 py-px rounded bg-amber-500/15 text-amber-500 shrink-0">WIP</span>
          )}
          <span
            className={`text-sm truncate cursor-pointer rounded px-1 -mx-1 hover:bg-muted transition-colors ${
              subtaskDone(st) ? 'line-through text-muted-foreground' : ''
            }`}
            onClick={() => onStartEdit(st)}
          >
            {st.title}
          </span>
        </div>
      )}

      {/* Priority (click to cycle) */}
      <button
        onClick={() => onCyclePriority(st.id)}
        className="shrink-0 p-0.5 rounded hover:bg-muted transition-colors cursor-pointer"
        title={`Priority: ${st.priority ?? 'medium'} — click to cycle`}
      >
        <SubtaskPriorityIcon priority={st.priority} />
      </button>

      {/* Actions */}
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/st:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="sm"
          className={`h-6 w-6 p-0 ${(st.notes?.length ?? 0) > 0 ? 'opacity-100 text-muted-foreground' : ''}`}
          onClick={() => setShowNotes(!showNotes)}
          title="Notes"
        >
          <MessageSquare className="h-3 w-3" />
          {(st.notes?.length ?? 0) > 0 && (
            <span className="absolute -top-0.5 -right-0.5 text-[8px] bg-primary text-primary-foreground rounded-full h-3 w-3 flex items-center justify-center">
              {st.notes!.length}
            </span>
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={() => onStartEdit(st)}
        >
          <Pencil className="h-3 w-3" />
          <span className="sr-only">Edit</span>
        </Button>
        {onPromote && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => onPromote(st.id)}
            title="Promote to task"
          >
            <ArrowUp className="h-3 w-3" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 hover:text-destructive"
          onClick={() => onRemove(st.id)}
        >
          <Trash2 className="h-3 w-3" />
          <span className="sr-only">Remove</span>
        </Button>
      </div>

      </div>

      {/* Subtask notes */}
      {showNotes && (
        <div className="ml-8 px-2 pb-1.5 space-y-1.5">
          <div className="flex gap-1.5">
            <Input
              placeholder="Add note to subtask..."
              value={noteVal}
              onChange={(e) => setNoteVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && noteVal.trim()) {
                  e.preventDefault()
                  onAddNote(st.id, noteVal.trim())
                  setNoteVal('')
                }
              }}
              className="h-6 text-xs flex-1"
            />
          </div>
          {st.notes?.map((n) => (
            editSubNoteId === n.id ? (
              <div key={n.id} className="text-xs bg-muted/30 rounded px-2 py-1">
                <Input
                  value={editSubNoteDraft}
                  onChange={(e) => setEditSubNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); if (editSubNoteDraft.trim()) onEditNote(st.id, n.id, editSubNoteDraft.trim()); setEditSubNoteId(null) }
                    if (e.key === 'Escape') setEditSubNoteId(null)
                  }}
                  onBlur={() => { if (editSubNoteDraft.trim() && editSubNoteDraft.trim() !== n.text) onEditNote(st.id, n.id, editSubNoteDraft.trim()); setEditSubNoteId(null) }}
                  className="h-6 text-xs"
                  autoFocus
                />
              </div>
            ) : (
              <div key={n.id} className="group/note flex gap-2 text-xs bg-muted/30 rounded px-2 py-1">
                <div className="flex-1 min-w-0">
                  <p className="whitespace-pre-wrap text-foreground/80">{n.text}</p>
                  <span className="text-[9px] text-muted-foreground/50 tabular-nums">
                    {formatRelativeTime(n.timestamp)}
                  </span>
                </div>
                <div className="flex gap-0.5 shrink-0 opacity-0 group-hover/note:opacity-100 transition-opacity self-start">
                  <button
                    onClick={() => { setEditSubNoteId(n.id); setEditSubNoteDraft(n.text) }}
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => onRemoveNote(st.id, n.id)}
                    className="text-muted-foreground hover:text-destructive cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  )
}

export function TaskDetailPanel({
  task,
  taskKey,
  open,
  onOpenChange,
  onUpdate,
  onDelete,
  allTasks = [],
  onLinkTask,
  onPromoteSubtask,
}: TaskDetailPanelProps) {
  // -- Relations (blocks, supports, relates) --------------------------------
  const { items: allRelations, create: createRelation, remove: removeRelation } = useRelations(task?.id)

  // -- Goals for goal picker (covers old 'project' entities too) ─────────────
  const { items: allEntitiesForPicker } = useEntities()
  const activeProjects = useMemo(
    () => allEntitiesForPicker.filter((p) => isGoal(p) && p.status !== 'archived'),
    [allEntitiesForPicker],
  )

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

  // Notes
  const [noteInput, setNoteInput] = useState('')
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [editingNoteDraft, setEditingNoteDraft] = useState('')

  // Set parent (make this task a subtask of another)
  const [showParentSearch, setShowParentSearch] = useState(false)
  const [parentSearch, setParentSearch] = useState('')
  const parentInputRef = useRef<HTMLInputElement>(null)

  // Blocked by
  const [showBlockerSearch, setShowBlockerSearch] = useState(false)
  const [blockerSearch, setBlockerSearch] = useState('')
  const blockerInputRef = useRef<HTMLInputElement>(null)

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
    setShowBlockerSearch(false)
    setBlockerSearch('')
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

  // Auto-focus blocker search input
  useEffect(() => {
    if (showBlockerSearch) blockerInputRef.current?.focus()
  }, [showBlockerSearch])

  // Blocker helpers — powered by Relations primitive
  const blockerRelations = useMemo(
    () => allRelations.filter((r): r is Relation => r.type === 'blocks' && r.toId === task?.id),
    [allRelations, task?.id],
  )
  const blockedByIds = useMemo(() => blockerRelations.map((r) => r.fromId), [blockerRelations])

  // "Supports" and "relates" relations for display
  const supportRelations = useMemo(
    () => allRelations.filter((r): r is Relation => r.type === 'supports' && (r.fromId === task?.id || r.toId === task?.id)),
    [allRelations, task?.id],
  )
  const relatesRelations = useMemo(
    () => allRelations.filter((r): r is Relation => r.type === 'relates' && (r.fromId === task?.id || r.toId === task?.id)),
    [allRelations, task?.id],
  )

  const blockerEntities = useMemo(
    () => allTasks.filter((t) => blockedByIds.includes(t.id)),
    [allTasks, blockedByIds],
  )

  // Related entities (supports + relates)
  const linkedEntityIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of [...supportRelations, ...relatesRelations]) {
      ids.add(r.fromId === task?.id ? r.toId : r.fromId)
    }
    return ids
  }, [supportRelations, relatesRelations, task?.id])

  const linkedEntities = useMemo(
    () => allTasks.filter((t) => linkedEntityIds.has(t.id)),
    [allTasks, linkedEntityIds],
  )

  const blockerCandidates = useMemo(() => {
    if (!task) return []
    return allTasks.filter((t) => {
      if (t.id === task.id) return false
      if (t.status === 'archived') return false
      if (blockedByIds.includes(t.id)) return false
      if (blockerSearch && !t.title.toLowerCase().includes(blockerSearch.toLowerCase())) return false
      return true
    })
  }, [task, allTasks, blockedByIds, blockerSearch])

  const addBlocker = useCallback(
    (blockerId: string) => {
      if (!task) return
      createRelation.mutate({
        id: crypto.randomUUID(),
        fromId: blockerId,
        toId: task.id,
        type: 'blocks',
      })
      const metadata = addActivity(task.metadata, `Blocked by "${allTasks.find((t) => t.id === blockerId)?.title}"`)
      onUpdate(task.id, { metadata })
      setBlockerSearch('')
    },
    [task, allTasks, onUpdate, createRelation],
  )

  const removeBlockerRelation = useCallback(
    (blockerId: string) => {
      if (!task) return
      const rel = blockerRelations.find((r) => r.fromId === blockerId)
      if (rel) removeRelation.mutate(rel.id)
      const metadata = addActivity(task.metadata, `Unblocked from "${allTasks.find((t) => t.id === blockerId)?.title}"`)
      onUpdate(task.id, { metadata })
    },
    [task, allTasks, onUpdate, blockerRelations, removeRelation],
  )

  const addRelation = useCallback(
    (targetId: string, type: 'supports' | 'relates') => {
      if (!task) return
      createRelation.mutate({
        id: crypto.randomUUID(),
        fromId: task.id,
        toId: targetId,
        type,
      })
      const label = type === 'supports' ? 'Supports' : 'Related to'
      const metadata = addActivity(task.metadata, `${label} "${allTasks.find((t) => t.id === targetId)?.title}"`)
      onUpdate(task.id, { metadata })
      setBlockerSearch('')
    },
    [task, allTasks, onUpdate, createRelation],
  )

  const removeRelationById = useCallback(
    (relationId: string) => {
      removeRelation.mutate(relationId)
    },
    [removeRelation],
  )

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
      const metadata = addActivity(task.metadata, `Status changed to **${status}**`)
      onUpdate(task.id, { status, metadata })
    },
    [task, onUpdate],
  )

  const handlePriorityChange = useCallback(
    (priority: EntityPriority) => {
      if (!task) return
      const metadata = addActivity(task.metadata, `Priority changed to **${priority}**`)
      onUpdate(task.id, { priority, metadata })
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
      const allSubs = getSubtasks(task.metadata)
      const target = allSubs.find((s) => s.id === subtaskId)
      const subtasks = allSubs.map((s) => {
        if (s.id !== subtaskId) return s
        const current = subtaskStatus(s)
        const next: SubtaskStatus = current === 'todo' ? 'in-progress' : current === 'in-progress' ? 'done' : 'todo'
        return { ...s, done: next === 'done', status: next }
      })
      const derivedStatus = deriveStatusFromSubtasks(subtasks)
      const current = target ? subtaskStatus(target) : 'todo'
      const next = current === 'todo' ? 'in-progress' : current === 'in-progress' ? 'done' : 'todo'
      const updatedMeta = target ? addActivity(task.metadata, `Subtask "${target.title}" → **${next}**`) : task.metadata
      onUpdate(task.id, {
        metadata: { ...updatedMeta, subtasks },
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

  const handleSubtaskCyclePriority = useCallback(
    (subtaskId: string) => {
      if (!task) return
      const subtasks = getSubtasks(task.metadata).map((s) => {
        if (s.id !== subtaskId) return s
        const current = s.priority ?? 'medium'
        const idx = SUBTASK_PRIORITY_ORDER.indexOf(current)
        const next = SUBTASK_PRIORITY_ORDER[(idx + 1) % SUBTASK_PRIORITY_ORDER.length]
        return { ...s, priority: next }
      })
      onUpdate(task.id, { metadata: { ...task.metadata, subtasks }, updatedAt: new Date().toISOString() })
    },
    [task, onUpdate],
  )

  const handleSubtaskAddNote = useCallback(
    (subtaskId: string, text: string) => {
      if (!task) return
      const subtasks = getSubtasks(task.metadata).map((s) => {
        if (s.id !== subtaskId) return s
        const note = { id: crypto.randomUUID(), text, timestamp: new Date().toISOString() }
        return { ...s, notes: [note, ...(s.notes ?? [])] }
      })
      onUpdate(task.id, { metadata: { ...task.metadata, subtasks }, updatedAt: new Date().toISOString() })
    },
    [task, onUpdate],
  )

  const handleSubtaskRemoveNote = useCallback(
    (subtaskId: string, noteId: string) => {
      if (!task) return
      const subtasks = getSubtasks(task.metadata).map((s) => {
        if (s.id !== subtaskId) return s
        const notes = (s.notes ?? []).filter((n) => n.id !== noteId)
        return { ...s, notes: notes.length > 0 ? notes : undefined }
      })
      onUpdate(task.id, { metadata: { ...task.metadata, subtasks }, updatedAt: new Date().toISOString() })
    },
    [task, onUpdate],
  )

  const handleSubtaskEditNote = useCallback(
    (subtaskId: string, noteId: string, text: string) => {
      if (!task) return
      const subtasks = getSubtasks(task.metadata).map((s) => {
        if (s.id !== subtaskId) return s
        const notes = (s.notes ?? []).map((n) => n.id === noteId ? { ...n, text } : n)
        return { ...s, notes }
      })
      onUpdate(task.id, { metadata: { ...task.metadata, subtasks }, updatedAt: new Date().toISOString() })
    },
    [task, onUpdate],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const handleSubtaskDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!task) return
      const { active, over } = event
      if (!over || active.id === over.id) return
      const subtasks = getSubtasks(task.metadata)
      const oldIndex = subtasks.findIndex((s) => s.id === active.id)
      const newIndex = subtasks.findIndex((s) => s.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return
      const updated = [...subtasks]
      const [moved] = updated.splice(oldIndex, 1)
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

          <div className="px-5 pb-2">
            <AIAction tool="break-down" entityId={task.id} label="Break into steps" />
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

            {/* Goal */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                <FolderKanban className="h-3 w-3" />
                Goal
              </span>
              <Select
                value={(task.metadata.projectId as string) ?? 'none'}
                onValueChange={(v) => {
                  if (!task) return
                  onUpdate(task.id, {
                    metadata: {
                      ...task.metadata,
                      projectId: v === 'none' ? undefined : v,
                    },
                  })
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="No goal" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No goal</SelectItem>
                  {activeProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                  ))}
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

            {/* Dependencies & Relations */}
            <div className="grid grid-cols-[120px_1fr] items-start gap-2">
              <span className="text-xs text-muted-foreground font-medium flex items-center gap-1 pt-1">
                <Link className="h-3 w-3" />
                Dependencies
              </span>
              <div className="space-y-1">
                {/* Current blockers */}
                {blockerEntities.map((b) => (
                  <div key={b.id} className="flex items-center gap-1.5 text-xs bg-destructive/10 text-destructive rounded px-2 py-1">
                    <span className="truncate flex-1">{b.title}</span>
                    <button
                      onClick={() => removeBlockerRelation(b.id)}
                      className="shrink-0 hover:text-destructive/80 cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}

                {showBlockerSearch ? (
                  <div className="space-y-1">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        ref={blockerInputRef}
                        placeholder="Search tasks..."
                        value={blockerSearch}
                        onChange={(e) => setBlockerSearch(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setShowBlockerSearch(false)
                            setBlockerSearch('')
                          }
                        }}
                        className="h-7 text-xs pl-7"
                      />
                    </div>
                    {blockerCandidates.length > 0 ? (
                      <div className="max-h-48 overflow-y-auto rounded-md border">
                        {blockerCandidates.slice(0, 8).map((t) => (
                          <div
                            key={t.id}
                            className="flex items-center gap-1 px-2 py-1.5 text-xs border-b last:border-b-0 hover:bg-muted/30"
                          >
                            <CheckSquare className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="truncate flex-1">{t.title}</span>
                            <button
                              className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 cursor-pointer shrink-0"
                              onClick={() => addBlocker(t.id)}
                            >
                              blocks
                            </button>
                            <button
                              className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 cursor-pointer shrink-0"
                              onClick={() => addRelation(t.id, 'supports')}
                            >
                              supports
                            </button>
                            <button
                              className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:bg-muted/80 cursor-pointer shrink-0"
                              onClick={() => addRelation(t.id, 'relates')}
                            >
                              relates
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : blockerSearch ? (
                      <p className="text-[11px] text-muted-foreground py-1">No matching tasks</p>
                    ) : null}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground gap-1.5 cursor-pointer"
                    onClick={() => setShowBlockerSearch(true)}
                  >
                    Link task
                  </Button>
                )}
              </div>
            </div>

            {/* Related tasks (supports + relates) */}
            {(linkedEntities.length > 0 || supportRelations.length > 0 || relatesRelations.length > 0) && (
              <div className="grid grid-cols-[120px_1fr] items-start gap-2">
                <span className="text-xs text-muted-foreground font-medium flex items-center gap-1 pt-1">
                  <Link className="h-3 w-3" />
                  Relations
                </span>
                <div className="space-y-1">
                  {[...supportRelations, ...relatesRelations].map((rel) => {
                    const otherId = rel.fromId === task.id ? rel.toId : rel.fromId
                    const other = allTasks.find((t) => t.id === otherId)
                    if (!other) return null
                    return (
                      <div key={rel.id} className="flex items-center gap-1.5 text-xs bg-muted/50 rounded px-2 py-1">
                        <span className="text-[10px] text-muted-foreground shrink-0 uppercase font-medium">{rel.type}</span>
                        <span className="truncate flex-1">{other.title}</span>
                        <button
                          onClick={() => removeRelationById(rel.id)}
                          className="shrink-0 hover:text-destructive cursor-pointer"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Visibility */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium">Visibility</span>
              <Select
                value={task.visibility}
                onValueChange={(v) => {
                  if (!task) return
                  const metadata = addActivity(task.metadata, `Visibility changed to ${v}`)
                  onUpdate(task.id, { visibility: v as 'private' | 'shared', metadata })
                }}
              >
                <SelectTrigger className="h-8 text-xs w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="shared">Shared</SelectItem>
                </SelectContent>
              </Select>
            </div>

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

          {/* Notes */}
          <div className="border-t mx-5" />
          <div className="px-5 py-4">
            <h3 className="text-xs font-medium text-muted-foreground mb-2">
              Notes
              {getNotes(task.metadata).length > 0 && (
                <span className="ml-1.5">({getNotes(task.metadata).length})</span>
              )}
            </h3>
            <div className="flex gap-1.5 mb-2">
              <Textarea
                placeholder="Add a note..."
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && noteInput.trim()) {
                    e.preventDefault()
                    const metadata = addNote(
                      addActivity(task.metadata, 'Added a note'),
                      noteInput.trim(),
                    )
                    onUpdate(task.id, { metadata })
                    setNoteInput('')
                  }
                }}
                rows={2}
                className="text-xs resize-none flex-1"
              />
            </div>
            {getNotes(task.metadata).length > 0 && (
              <div className="space-y-2">
                {getNotes(task.metadata).map((note) => {
                  const isEditing = editingNoteId === note.id

                  if (isEditing) {
                    return (
                      <div key={note.id} className="text-xs bg-muted/30 rounded-lg px-3 py-2">
                        <Textarea
                          value={editingNoteDraft}
                          onChange={(e) => setEditingNoteDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              if (editingNoteDraft.trim()) {
                                const metadata = updateNoteText(task.metadata, note.id, editingNoteDraft.trim())
                                onUpdate(task.id, { metadata })
                              }
                              setEditingNoteId(null)
                            }
                            if (e.key === 'Escape') setEditingNoteId(null)
                          }}
                          onBlur={() => {
                            if (editingNoteDraft.trim() && editingNoteDraft.trim() !== note.text) {
                              const metadata = updateNoteText(task.metadata, note.id, editingNoteDraft.trim())
                              onUpdate(task.id, { metadata })
                            }
                            setEditingNoteId(null)
                          }}
                          rows={3}
                          className="text-xs resize-none"
                          autoFocus
                        />
                      </div>
                    )
                  }

                  // Detect JSON
                  let jsonData: Record<string, unknown> | null = null
                  const trimmed = note.text.trim()
                  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    try { jsonData = JSON.parse(trimmed) } catch { /* not json */ }
                  }

                  return (
                    <div key={note.id} className="group flex gap-2 text-xs bg-muted/30 rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        {jsonData ? (
                          <NoteJsonView data={jsonData} />
                        ) : (
                          <p className="whitespace-pre-wrap text-foreground/90">{note.text}</p>
                        )}
                        <span className="text-[10px] text-muted-foreground/50 tabular-nums mt-1 block">
                          {formatRelativeTime(note.timestamp)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => { setEditingNoteId(note.id); setEditingNoteDraft(note.text) }}
                          className="text-muted-foreground hover:text-foreground cursor-pointer"
                          title="Edit"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => {
                            const metadata = removeNote(task.metadata, note.id)
                            onUpdate(task.id, { metadata })
                          }}
                          className="text-muted-foreground hover:text-destructive cursor-pointer"
                          title="Delete"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  )
                })}
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

            {/* Subtask list — drag-to-reorder */}
            {subtasks.length > 0 && (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleSubtaskDragEnd}
              >
                <SortableContext
                  items={subtasks.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="rounded-md border divide-y">
                    {subtasks.map((st) => (
                      <SortableSubtaskRow
                        key={st.id}
                        st={st}
                        onToggle={handleSubtaskToggle}
                        onRemove={handleSubtaskRemove}
                        onStartEdit={(s) => {
                          setSubtaskDraft(s.title)
                          setEditingSubtaskId(s.id)
                        }}
                        isEditing={editingSubtaskId === st.id}
                        editDraft={subtaskDraft}
                        onEditDraftChange={setSubtaskDraft}
                        onEditCommit={handleSubtaskRename}
                        onEditCancel={() => {
                          setEditingSubtaskId(null)
                          setSubtaskDraft('')
                        }}
                        editRef={subtaskEditRef}
                        onAddNote={handleSubtaskAddNote}
                        onRemoveNote={handleSubtaskRemoveNote}
                        onEditNote={handleSubtaskEditNote}
                        onCyclePriority={handleSubtaskCyclePriority}
                        onPromote={onPromoteSubtask && task ? (subtaskId) => {
                          const sub = subtasks.find((s) => s.id === subtaskId)
                          if (sub && task) onPromoteSubtask(task.id, sub)
                        } : undefined}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
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

        {/* Activity timeline */}
        {task && getActivity(task.metadata).length > 0 && (
          <>
            <div className="border-t mx-5" />
            <div className="px-5 py-4">
              <Collapsible>
                <CollapsibleTrigger className="flex items-center gap-2 text-xs font-medium text-muted-foreground cursor-pointer group">
                  <History className="h-3.5 w-3.5" />
                  Activity
                  <span className="text-[10px] bg-muted rounded-full px-1.5 py-0.5">
                    {getActivity(task.metadata).length}
                  </span>
                  <ChevronRight className="h-3 w-3 ml-auto transition-transform group-data-[state=open]:rotate-90" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 space-y-1.5 ml-1 border-l border-dashed pl-3">
                    {getActivity(task.metadata).map((entry) => (
                      <div key={entry.id} className="flex items-start gap-2 text-xs">
                        <span className="text-muted-foreground/50 tabular-nums shrink-0">
                          {formatRelativeTime(entry.timestamp)}
                        </span>
                        <span
                          className="text-muted-foreground"
                          dangerouslySetInnerHTML={{
                            __html: entry.action.replace(
                              /\*\*(.+?)\*\*/g,
                              '<strong class="text-foreground font-medium">$1</strong>',
                            ),
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </>
        )}

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
