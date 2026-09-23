import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
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
import { X, Play, Pause, SkipForward, Square, Timer, Flame, Crown, ChevronRight, Plus, CheckCircle2, ChevronDown, Pencil, Trash2, GripVertical, MessageSquare, Send, ExternalLink, ChevronsUp, ArrowUp, ArrowDown, Minus as MinusIcon, Inbox, Zap, Presentation } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { useFocusStore } from '@/stores/focus-store'
import { TaskDetailPanel } from '@/pages/tasks/task-detail-panel'
import { CommandBar } from '@/pages/ai/command-bar'
import { useGlobalShortcuts } from '@/hooks/use-keybindings'
import { LyraCoach } from '@/pages/deep-work/lyra-coach'
import { SessionPlanner } from '@/pages/deep-work/session-planner'
import { SessionReflection } from '@/pages/deep-work/session-reflection'
import { useUiStore } from '@/stores/ui-store'
import type { Entity, Tracker } from '@/core/types'

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

type SubtaskStatus = 'todo' | 'in-progress' | 'done'
type SubtaskNote = { id: string; text: string; timestamp: string }
type SubtaskPriority = 'urgent' | 'high' | 'medium' | 'low'
type Subtask = { id: string; title: string; done: boolean; status?: SubtaskStatus; priority?: SubtaskPriority; notes?: SubtaskNote[] }

function stStatus(s: Subtask): SubtaskStatus {
  if (s.status) return s.status
  return s.done ? 'done' : 'todo'
}
function stDone(s: Subtask): boolean {
  return stStatus(s) === 'done'
}

/* Phase-based color tokens */
const PHASE_STYLES = {
  idle: {
    bg: 'bg-[#0a0a0f]',
    timerColor: 'text-zinc-400',
    accent: 'text-zinc-500',
    ring: 'from-zinc-800 to-zinc-900',
    trackBg: 'bg-zinc-800/50',
    trackFill: 'bg-zinc-600',
  },
  work: {
    bg: 'bg-[#0a0a0f]',
    timerColor: 'text-amber-400',
    accent: 'text-amber-500',
    ring: 'from-amber-900/40 to-orange-900/20',
    trackBg: 'bg-amber-950/30',
    trackFill: 'bg-amber-500',
  },
  break: {
    bg: 'bg-[#060f0a]',
    timerColor: 'text-emerald-400',
    accent: 'text-emerald-500',
    ring: 'from-emerald-900/30 to-green-900/15',
    trackBg: 'bg-emerald-950/30',
    trackFill: 'bg-emerald-500',
  },
  'long-break': {
    bg: 'bg-[#060a12]',
    timerColor: 'text-sky-400',
    accent: 'text-sky-500',
    ring: 'from-sky-900/30 to-blue-900/15',
    trackBg: 'bg-sky-950/30',
    trackFill: 'bg-sky-500',
  },
} as const

function InlineEdit({ value, onSave, className }: { value: string; onSave: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(value)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [editing, value])

  const save = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onSave(trimmed)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`bg-transparent border-0 border-b border-dashed border-zinc-600 focus:border-amber-500/50 focus:outline-none px-0 py-0 ${className ?? ''}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') setEditing(false)
        }}
        onBlur={save}
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <span className="group/edit flex items-center gap-1.5 min-w-0 flex-1">
      <span className={className}>{value}</span>
      <button
        onClick={(e) => { e.stopPropagation(); setEditing(true) }}
        className="opacity-0 group-hover/edit:opacity-100 transition-opacity text-zinc-600 hover:text-amber-400 shrink-0 cursor-pointer"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </span>
  )
}

interface TaskNote {
  id: string
  text: string
  timestamp: string
}

function getNotes(metadata: Record<string, unknown>): TaskNote[] {
  return Array.isArray(metadata.notes) ? (metadata.notes as TaskNote[]) : []
}

function QuickNote({ entity, onUpdate }: { entity: Entity; onUpdate: (id: string, updates: Partial<Entity>) => void }) {
  const [value, setValue] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const notes = getNotes(entity.metadata)

  const handleAdd = () => {
    if (!value.trim()) return
    const note: TaskNote = { id: crypto.randomUUID(), text: value.trim(), timestamp: new Date().toISOString() }
    const existing = getNotes(entity.metadata)
    onUpdate(entity.id, {
      metadata: { ...entity.metadata, notes: [note, ...existing] },
      updatedAt: new Date().toISOString(),
    })
    setValue('')
  }

  return (
    <div className="pt-2 px-3 space-y-1.5">
      {/* Existing notes (collapsed by default) */}
      {notes.length > 0 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-zinc-400 transition-colors cursor-pointer"
        >
          <MessageSquare className="h-3 w-3" />
          {notes.length} note{notes.length !== 1 ? 's' : ''}
          <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        </button>
      )}
      {expanded && notes.slice(0, 5).map((n) => (
        editId === n.id ? (
          <div key={n.id} className="text-[11px] bg-white/[0.02] rounded px-2.5 py-1.5 border border-amber-500/30">
            <input
              className="w-full bg-transparent text-zinc-300 text-[11px] focus:outline-none"
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (editDraft.trim()) {
                    const updated = getNotes(entity.metadata).map((x) => x.id === n.id ? { ...x, text: editDraft.trim() } : x)
                    onUpdate(entity.id, { metadata: { ...entity.metadata, notes: updated }, updatedAt: new Date().toISOString() })
                  }
                  setEditId(null)
                }
                if (e.key === 'Escape') setEditId(null)
              }}
              onBlur={() => {
                if (editDraft.trim() && editDraft.trim() !== n.text) {
                  const updated = getNotes(entity.metadata).map((x) => x.id === n.id ? { ...x, text: editDraft.trim() } : x)
                  onUpdate(entity.id, { metadata: { ...entity.metadata, notes: updated }, updatedAt: new Date().toISOString() })
                }
                setEditId(null)
              }}
              autoFocus
            />
          </div>
        ) : (
          <div key={n.id} className="group/note flex gap-2 text-[11px] text-zinc-400 bg-white/[0.02] rounded px-2.5 py-1.5 border border-zinc-800/30">
            <div className="flex-1 min-w-0">
              <p className="whitespace-pre-wrap">{n.text}</p>
              <span className="text-[9px] text-zinc-600 tabular-nums">
                {new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div className="flex gap-1 shrink-0 opacity-0 group-hover/note:opacity-100 transition-opacity self-start">
              <button
                onClick={() => { setEditId(n.id); setEditDraft(n.text) }}
                className="text-zinc-600 hover:text-amber-400 cursor-pointer"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                onClick={() => {
                  const existing = getNotes(entity.metadata).filter((x) => x.id !== n.id)
                  onUpdate(entity.id, {
                    metadata: { ...entity.metadata, notes: existing.length > 0 ? existing : undefined },
                    updatedAt: new Date().toISOString(),
                  })
                }}
                className="text-zinc-600 hover:text-red-400 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>
        )
      ))}
      {/* Quick add */}
      <div className="flex items-center gap-2">
        <MessageSquare className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
        <input
          className="flex-1 text-sm bg-transparent border-0 border-b border-dashed border-zinc-800 px-0 py-1 focus:outline-none focus:border-amber-500/50 placeholder:text-zinc-700 text-zinc-300"
          placeholder="Add a note..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) {
              handleAdd()
            }
          }}
        />
        {value.trim() && (
          <button onClick={handleAdd} className="text-amber-500/70 hover:text-amber-400 cursor-pointer shrink-0">
            <Send className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function QuickAddSubtask({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex items-center gap-2 pt-1.5 px-3">
      <Plus className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
      <input
        className="flex-1 text-sm bg-transparent border-0 border-b border-dashed border-zinc-800 px-0 py-1 focus:outline-none focus:border-amber-500/50 placeholder:text-zinc-700 text-zinc-300"
        placeholder="Add subtask..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) {
            onAdd(value.trim())
            setValue('')
          }
        }}
      />
    </div>
  )
}

/* ─── Sortable subtask row for Emperor Time ─── */

function SortableEmperorSubtask({
  sub,
  isCurrent,
  item,
  onToggle,
  onRename,
  onAddNote,
  onRemoveNote,
  onEditNote,
}: {
  sub: Subtask
  isCurrent: boolean
  item: Entity
  onToggle: (id: string) => void
  onRename: (entity: Entity, subtaskId: string, title: string) => void
  onAddNote: (entity: Entity, subtaskId: string, text: string) => void
  onRemoveNote: (entity: Entity, subtaskId: string, noteId: string) => void
  onEditNote: (entity: Entity, subtaskId: string, noteId: string, text: string) => void
}) {
  const [showNotes, setShowNotes] = useState(false)
  const [noteVal, setNoteVal] = useState('')
  const [editSubNoteId, setEditSubNoteId] = useState<string | null>(null)
  const [editSubNoteDraft, setEditSubNoteDraft] = useState('')
  const st = stStatus(sub)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sub.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg transition-colors group/sub ${
        isCurrent
          ? 'bg-amber-500/[0.06] border border-amber-500/15'
          : st === 'done'
            ? 'opacity-40'
            : st === 'in-progress'
              ? 'bg-amber-500/[0.03] border border-amber-500/10'
              : 'hover:bg-white/[0.03]'
      }`}
    >
    <div className="flex items-center gap-3 py-1.5 px-3">
      <button
        type="button"
        className="shrink-0 cursor-grab active:cursor-grabbing text-zinc-700 hover:text-zinc-500 touch-none"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      <button
        onClick={() => onToggle(sub.id)}
        className={`h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors cursor-pointer ${
          st === 'done'
            ? 'bg-emerald-600 border-emerald-600'
            : st === 'in-progress'
              ? 'border-amber-500 bg-amber-500/20'
              : 'border-zinc-700'
        }`}
        title={`${st} — click to cycle`}
      >
        {st === 'done' && (
          <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
        {st === 'in-progress' && (
          <div className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        )}
      </button>

      {st === 'in-progress' && <span className="text-[9px] font-medium text-amber-500/70 shrink-0">WIP</span>}
      {isCurrent && st === 'todo' && <span className="text-amber-500/70 text-xs shrink-0">&rarr;</span>}
      {sub.priority && sub.priority !== 'medium' && (
        <span className="shrink-0" title={sub.priority}>
          {sub.priority === 'urgent' && <ChevronsUp className="h-3.5 w-3.5 text-red-500" />}
          {sub.priority === 'high' && <ArrowUp className="h-3.5 w-3.5 text-orange-500" />}
          {sub.priority === 'low' && <ArrowDown className="h-3.5 w-3.5 text-blue-400" />}
        </span>
      )}
      {sub.priority === 'medium' && (
        <span className="shrink-0" title="medium">
          <MinusIcon className="h-3.5 w-3.5 text-yellow-500" />
        </span>
      )}
      <InlineEdit
        value={sub.title}
        onSave={(v) => onRename(item, sub.id, v)}
        className={`text-sm ${
          st === 'done'
            ? 'line-through text-zinc-600'
            : st === 'in-progress'
              ? 'font-medium text-amber-300'
              : isCurrent
                ? 'font-medium text-zinc-200'
                : 'text-zinc-400'
        }`}
      />
      <button
        onClick={(e) => { e.stopPropagation(); setShowNotes(!showNotes) }}
        className={`shrink-0 transition-colors cursor-pointer ${
          (sub.notes?.length ?? 0) > 0 ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-700 hover:text-zinc-500 opacity-0 group-hover/sub:opacity-100'
        }`}
        title="Notes"
      >
        <MessageSquare className="h-3 w-3" />
      </button>
    </div>

    {/* Subtask notes */}
    {showNotes && (
      <div className="ml-12 pb-2 space-y-1">
        <div className="flex items-center gap-2">
          <input
            className="flex-1 text-xs bg-transparent border-0 border-b border-dashed border-zinc-800 px-0 py-0.5 focus:outline-none focus:border-amber-500/50 placeholder:text-zinc-700 text-zinc-300"
            placeholder="Add note..."
            value={noteVal}
            onChange={(e) => setNoteVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && noteVal.trim()) {
                onAddNote(item, sub.id, noteVal.trim())
                setNoteVal('')
              }
            }}
          />
          {noteVal.trim() && (
            <button onClick={() => { onAddNote(item, sub.id, noteVal.trim()); setNoteVal('') }} className="text-amber-500/70 hover:text-amber-400 cursor-pointer shrink-0">
              <Send className="h-3 w-3" />
            </button>
          )}
        </div>
        {sub.notes?.map((n) => (
          editSubNoteId === n.id ? (
            <div key={n.id} className="text-[11px] bg-white/[0.02] rounded px-2 py-1 border border-amber-500/30">
              <input
                className="w-full bg-transparent text-zinc-300 text-[11px] focus:outline-none"
                value={editSubNoteDraft}
                onChange={(e) => setEditSubNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { if (editSubNoteDraft.trim()) onEditNote(item, sub.id, n.id, editSubNoteDraft.trim()); setEditSubNoteId(null) }
                  if (e.key === 'Escape') setEditSubNoteId(null)
                }}
                onBlur={() => { if (editSubNoteDraft.trim() && editSubNoteDraft.trim() !== n.text) onEditNote(item, sub.id, n.id, editSubNoteDraft.trim()); setEditSubNoteId(null) }}
                autoFocus
              />
            </div>
          ) : (
            <div key={n.id} className="group/note flex gap-2 text-[11px] text-zinc-400 bg-white/[0.02] rounded px-2 py-1 border border-zinc-800/30">
              <div className="flex-1 min-w-0">
                <p className="whitespace-pre-wrap">{n.text}</p>
                <span className="text-[9px] text-zinc-600 tabular-nums">
                  {new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="flex gap-1 shrink-0 opacity-0 group-hover/note:opacity-100 transition-opacity self-start">
                <button
                  onClick={() => { setEditSubNoteId(n.id); setEditSubNoteDraft(n.text) }}
                  className="text-zinc-600 hover:text-amber-400 cursor-pointer"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={() => onRemoveNote(item, sub.id, n.id)}
                  className="text-zinc-600 hover:text-red-400 cursor-pointer"
                >
                  <Trash2 className="h-3 w-3" />
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

/* ─── Session Log Entry ─── */

interface ParsedNote {
  sessionId?: string
  task: string
  completed: string[]
  progress?: string
  distractions?: number
  goal?: string
}

function parseLogNote(raw?: string | null): ParsedNote | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw)
    if (typeof p === 'object' && p.task) return p as ParsedNote
  } catch { /* ignore */ }
  return null
}

function SessionLogEntry({ tracker, entityTitle, onUpdate, onDelete }: {
  tracker: Tracker
  entityTitle: string
  onUpdate: (id: string, note: string) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const parsed = parseLogNote(tracker.note)
  const [editCompleted, setEditCompleted] = useState<string[]>(parsed?.completed ?? [])
  const [newItem, setNewItem] = useState('')

  const time = new Date(tracker.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const handleSave = () => {
    const updated: ParsedNote = {
      ...(parsed ?? { task: entityTitle, completed: [] }),
      completed: editCompleted.filter((c) => c.trim()),
    }
    onUpdate(tracker.id, JSON.stringify(updated))
    setEditing(false)
  }

  const handleAddItem = () => {
    if (!newItem.trim()) return
    setEditCompleted([...editCompleted, newItem.trim()])
    setNewItem('')
  }

  const handleRemoveItem = (idx: number) => {
    setEditCompleted(editCompleted.filter((_, i) => i !== idx))
  }

  if (editing) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 tabular-nums shrink-0">{time}</span>
          <span className="text-sm text-zinc-200 font-medium truncate flex-1">{entityTitle}</span>
          <span className="text-xs text-zinc-500 tabular-nums">{tracker.value}m</span>
        </div>

        <div className="space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">What was done</span>
          {editCompleted.map((item, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <CheckCircle2 className="h-3 w-3 text-green-500/60 shrink-0" />
              <span className="text-xs text-zinc-300 flex-1">{item}</span>
              <button onClick={() => handleRemoveItem(i)} className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-600 hover:text-red-400">
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Plus className="h-3 w-3 text-zinc-600 shrink-0" />
            <input
              className="flex-1 text-xs bg-transparent border-0 border-b border-dashed border-zinc-800 px-0 py-1 focus:outline-none focus:border-amber-500/50 placeholder:text-zinc-700 text-zinc-300"
              placeholder="Add completed item..."
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddItem() }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button onClick={handleSave} className="text-[10px] font-medium px-2.5 py-1 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors">
            Save
          </button>
          <button onClick={() => { setEditing(false); setEditCompleted(parsed?.completed ?? []) }} className="text-[10px] font-medium px-2.5 py-1 rounded text-zinc-500 hover:text-zinc-300 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-2 py-1.5 group">
      <div className="w-1.5 h-1.5 rounded-full bg-amber-500/40 mt-1.5 shrink-0" />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">{time}</span>
          <span className="text-sm text-zinc-300 truncate flex-1">{entityTitle}</span>
          <span className="text-xs text-zinc-500 tabular-nums shrink-0">{tracker.value}m</span>
          {parsed?.progress && (
            <span className="text-[9px] text-zinc-600 tabular-nums shrink-0">{parsed.progress}</span>
          )}
          <button
            onClick={() => setEditing(true)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-600 hover:text-amber-400"
            title="Edit log"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={() => onDelete(tracker.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-600 hover:text-red-400"
            title="Delete log"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
        {parsed?.goal && (
          <p className="text-[10px] text-zinc-600 italic ml-6">{parsed.goal}</p>
        )}
        {parsed?.completed && parsed.completed.length > 0 && (
          <div className="space-y-0.5 ml-6">
            {parsed.completed.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-2.5 w-2.5 text-green-500/60 shrink-0" />
                <span className="text-[11px] text-zinc-400">{item}</span>
              </div>
            ))}
          </div>
        )}
        {parsed?.distractions && parsed.distractions > 0 && (
          <p className="text-[10px] text-zinc-600 ml-6 flex items-center gap-1">
            <Zap className="h-2.5 w-2.5" />{parsed.distractions} distraction{parsed.distractions !== 1 ? 's' : ''}
          </p>
        )}
      </div>
    </div>
  )
}

/* ─── Session History Panel ─── */

function SessionHistoryPanel({ sessionId, trackers, entityTitles, onUpdate, onDelete }: {
  sessionId: string | null
  trackers: Tracker[]
  entityTitles: Map<string, string>
  onUpdate: (id: string, note: string) => void
  onDelete: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(true)

  const sessionTrackers = useMemo(() => {
    if (!sessionId) return []
    return trackers
      .filter((t) => {
        if (t.unit !== 'focus-min') return false
        const note = parseLogNote(t.note)
        return note?.sessionId === sessionId
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }, [trackers, sessionId])

  const totalMinutes = useMemo(() => sessionTrackers.reduce((sum, t) => sum + t.value, 0), [sessionTrackers])

  if (sessionTrackers.length === 0) return null

  return (
    <div className="w-full rounded-xl border border-zinc-800/50 bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
      >
        <ChevronDown className={`h-3.5 w-3.5 text-zinc-600 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <Crown className="h-3 w-3 text-amber-500/50" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 flex-1">
          Session Log
        </span>
        <span className="text-[10px] text-zinc-600 tabular-nums">
          {sessionTrackers.length} pomodoro{sessionTrackers.length !== 1 ? 's' : ''}
        </span>
        <span className="text-xs font-medium text-amber-500/70 tabular-nums">{formatMinutes(totalMinutes)}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-0.5">
          {sessionTrackers.map((t) => (
            <SessionLogEntry
              key={t.id}
              tracker={t}
              entityTitle={entityTitles.get(t.entityId) || 'Unknown'}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function DeepWorkPage() {
  const navigate = useNavigate()

  // Deep Work renders outside AppLayout, which is where the global shortcuts normally live. The
  // capture dialog used to bring its own listener, so removing it would have quietly cost this
  // page ⌘K and ⌘⇧I — the two you most want while heads-down.
  useGlobalShortcuts(
    useMemo(
      () => ({
        'command-bar': () => useUiStore.getState().openCommandBar(),
        'quick-capture': () => useUiStore.getState().openCommandBar('/'),
      }),
      [],
    ),
  )
  const {
    activeEntityId,
    emperorEntityIds,
    sessionId,
    phase,
    currentSession,
    completedSessions,
    secondsLeft,
    isRunning,
    settings,
    preset,
    tick,
    pauseTimer,
    resumeTimer,
    completeWorkSession,
    completeBreak,
    endDeepWork,
    setPhase,
    setPreset,
    startEmperorTime,
  } = useFocusStore()
  const { items: allEntities, update, remove: removeEntity } = useEntities()
  const { items: allTrackers, create: createTracker, update: updateTracker, remove: removeTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)

  // Session planner state
  const [plannerSkipped, setPlannerSkipped] = useState(false)

  // Task detail drawer state
  const [detailTask, setDetailTask] = useState<Entity | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  // Distraction tally — reset each work phase
  const [distractions, setDistractions] = useState(0)
  const prevPhaseForDistractions = useRef(phase)
  useEffect(() => {
    if (phase === 'work' && prevPhaseForDistractions.current !== 'work') setDistractions(0)
    prevPhaseForDistractions.current = phase
  }, [phase])

  // Session micro-goal
  const [sessionGoal, setSessionGoal] = useState('')

  // Auto-pause on tab switch
  const [tabAway, setTabAway] = useState(false)
  useEffect(() => {
    const handler = () => {
      if (document.hidden && phase === 'work' && isRunning) {
        pauseTimer()
        setTabAway(true)
      }
      if (!document.hidden && tabAway) setTabAway(false)
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [phase, isRunning, pauseTimer, tabAway])

  const entityTitles = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of allEntities) m.set(e.id, e.title)
    return m
  }, [allEntities])

  const handleUpdateLog = useCallback((id: string, note: string) => {
    updateTracker.mutate({ id, updates: { note } })
  }, [updateTracker])

  const handleDeleteLog = useCallback((id: string) => {
    removeTracker.mutate(id)
  }, [removeTracker])

  const emperorEntities = useMemo(
    () => emperorEntityIds.map((id) => allEntities.find((e) => e.id === id)).filter(Boolean) as Entity[],
    [emperorEntityIds, allEntities],
  )

  const entity = allEntities.find((e) => e.id === activeEntityId)
  const subtasks = useMemo(
    () =>
      Array.isArray(entity?.metadata.subtasks)
        ? (entity.metadata.subtasks as Subtask[])
        : [],
    [entity],
  )

  // Post-session reflection
  const [showReflection, setShowReflection] = useState(false)
  const prevPhaseRef = useRef(phase)

  useEffect(() => {
    if (
      prevPhaseRef.current !== 'idle' &&
      phase === 'idle' &&
      completedSessions > 0
    ) {
      setShowReflection(true)
    }
    prevPhaseRef.current = phase
  }, [phase, completedSessions])

  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const totalDuration = useMemo(() => {
    if (phase === 'work') return settings.workMinutes * 60
    if (phase === 'break') return settings.breakMinutes * 60
    if (phase === 'long-break') return settings.longBreakMinutes * 60
    return settings.workMinutes * 60
  }, [phase, settings])

  // Sound
  const audioCtxRef = useRef<AudioContext | null>(null)
  const playChime = useCallback(() => {
    if (!settings.soundEnabled) return
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      const ctx = audioCtxRef.current
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = 800
      gain.gain.value = 0.3
      osc.start()
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8)
      osc.stop(ctx.currentTime + 0.8)
    } catch {
      // Audio not available
    }
  }, [settings.soundEnabled])

  // Track subtask state at session start to compute what was done
  const sessionStartSubtasksRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (phase === 'work' && entity) {
      const doneBefore = new Set(
        (Array.isArray(entity.metadata.subtasks) ? (entity.metadata.subtasks as Subtask[]) : [])
          .filter((s) => stDone(s)).map((s) => s.id),
      )
      sessionStartSubtasksRef.current = doneBefore
    }
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // Log focus session with what was accomplished
  const logSession = useCallback(() => {
    if (!activeEntityId) return
    const currentEntity = allEntities.find((e) => e.id === activeEntityId)
    const subs = Array.isArray(currentEntity?.metadata.subtasks) ? (currentEntity.metadata.subtasks as Subtask[]) : []
    const doneNow = subs.filter((s) => stDone(s))
    const completedThisSession = doneNow.filter((s) => !sessionStartSubtasksRef.current.has(s.id))
    const note = JSON.stringify({
      sessionId: sessionId ?? undefined,
      task: currentEntity?.title ?? '',
      completed: completedThisSession.map((s) => s.title),
      progress: subs.length > 0 ? `${doneNow.length}/${subs.length}` : undefined,
      preset,
      workMinutes: settings.workMinutes,
      pomodoroIndex: completedSessions + 1,
      workspace: (currentEntity?.metadata?.workspace as string) ?? null,
      distractions: distractions > 0 ? distractions : undefined,
      goal: sessionGoal || undefined,
    })
    createTracker.mutate({
      id: crypto.randomUUID(),
      entityId: activeEntityId,
      value: settings.workMinutes,
      unit: 'focus-min',
      note,
      timestamp: new Date().toISOString(),
      ownerId: currentUser?.id ?? '',
    })
  }, [activeEntityId, allEntities, settings.workMinutes, createTracker, currentUser, sessionId, preset, completedSessions, distractions, sessionGoal])

  const handleTimerEndRef = useRef<() => void>(() => {})
  useEffect(() => {
    handleTimerEndRef.current = () => {
      playChime()
      if (phaseRef.current === 'work') {
        logSession()
        completeWorkSession()
      } else {
        completeBreak()
      }
    }
  })

  // Update browser tab title with countdown
  useEffect(() => {
    if (phase === 'idle') {
      document.title = 'Lyra \u2022 Emperor Time'
    } else {
      const label = phase === 'work' ? 'Focus' : phase === 'break' ? 'Break' : 'Rest'
      document.title = `${formatTime(secondsLeft)} \u2013 ${label}`
    }
    return () => { document.title = 'Lyra' }
  }, [secondsLeft, phase])

  useEffect(() => {
    if (!isRunning || secondsLeft <= 0) return
    const interval = setInterval(() => {
      const done = tick()
      if (done) {
        clearInterval(interval)
        handleTimerEndRef.current()
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [isRunning, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Navigate away — pause timer but keep session alive
  const handleLeave = useCallback(() => {
    pauseTimer()
    navigate(-1)
  }, [pauseTimer, navigate])

  // Explicitly end the session (stop button).
  //
  // `navigate(-1)` is a no-op when this page is the first entry in the history stack — opened by
  // ⌘⇧D in a fresh tab, or from a bookmark. That left you pressing End and going nowhere, which
  // looks exactly like the button not working even though the session did end. React Router
  // keeps its position in `history.state.idx`, so 0 means there is nothing behind us.
  const handleEnd = useCallback(() => {
    endDeepWork()
    if (window.history.state?.idx) navigate(-1)
    else navigate('/')
  }, [endDeepWork, navigate])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleLeave()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleLeave])

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const handleSubtaskDragEnd = useCallback(
    (entityItem: Entity, event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const subs = Array.isArray(entityItem.metadata.subtasks) ? (entityItem.metadata.subtasks as Subtask[]) : []
      const oldIndex = subs.findIndex((s) => s.id === active.id)
      const newIndex = subs.findIndex((s) => s.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return
      const updated = [...subs]
      const [moved] = updated.splice(oldIndex, 1)
      updated.splice(newIndex, 0, moved)
      update.mutate({ id: entityItem.id, updates: { metadata: { ...entityItem.metadata, subtasks: updated } } })
    },
    [update],
  )

  // Cycle subtask: todo → in-progress → done
  const toggleSubtask = useCallback(
    (subtaskId: string) => {
      if (!entity) return
      const updated = subtasks.map((s) => {
        if (s.id !== subtaskId) return s
        const current = stStatus(s)
        const next: SubtaskStatus = current === 'todo' ? 'in-progress' : current === 'in-progress' ? 'done' : 'todo'
        return { ...s, done: next === 'done', status: next }
      })
      const allDone = updated.length > 0 && updated.every((s) => stDone(s))
      const hasWip = updated.some((s) => stStatus(s) === 'in-progress')
      const hasDone = updated.some((s) => stDone(s))
      const derivedStatus = allDone ? 'done' : (hasWip || hasDone) ? 'in-progress' : entity.status
      update.mutate({
        id: entity.id,
        updates: {
          metadata: { ...entity.metadata, subtasks: updated },
          status: derivedStatus,
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [entity, subtasks, update],
  )

  // Rename entity title
  const renameEntity = useCallback(
    (targetEntity: Entity, newTitle: string) => {
      update.mutate({
        id: targetEntity.id,
        updates: { title: newTitle, updatedAt: new Date().toISOString() },
      })
    },
    [update],
  )

  // Rename subtask on any entity
  const renameSubtask = useCallback(
    (targetEntity: Entity, subtaskId: string, newTitle: string) => {
      const subs = Array.isArray(targetEntity.metadata.subtasks)
        ? (targetEntity.metadata.subtasks as Subtask[])
        : []
      const updated = subs.map((s) =>
        s.id === subtaskId ? { ...s, title: newTitle } : s,
      )
      update.mutate({
        id: targetEntity.id,
        updates: {
          metadata: { ...targetEntity.metadata, subtasks: updated },
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [update],
  )

  // Add note to a subtask
  const addSubtaskNote = useCallback(
    (targetEntity: Entity, subtaskId: string, text: string) => {
      const subs = Array.isArray(targetEntity.metadata.subtasks)
        ? (targetEntity.metadata.subtasks as Subtask[])
        : []
      const note: SubtaskNote = { id: crypto.randomUUID(), text, timestamp: new Date().toISOString() }
      const updated = subs.map((s) =>
        s.id === subtaskId ? { ...s, notes: [note, ...(s.notes ?? [])] } : s,
      )
      update.mutate({
        id: targetEntity.id,
        updates: {
          metadata: { ...targetEntity.metadata, subtasks: updated },
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [update],
  )

  // Remove note from a subtask
  const removeSubtaskNote = useCallback(
    (targetEntity: Entity, subtaskId: string, noteId: string) => {
      const subs = Array.isArray(targetEntity.metadata.subtasks)
        ? (targetEntity.metadata.subtasks as Subtask[])
        : []
      const updated = subs.map((s) => {
        if (s.id !== subtaskId) return s
        const notes = (s.notes ?? []).filter((n) => n.id !== noteId)
        return { ...s, notes: notes.length > 0 ? notes : undefined }
      })
      update.mutate({
        id: targetEntity.id,
        updates: {
          metadata: { ...targetEntity.metadata, subtasks: updated },
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [update],
  )

  const editSubtaskNote = useCallback(
    (targetEntity: Entity, subtaskId: string, noteId: string, text: string) => {
      const subs = Array.isArray(targetEntity.metadata.subtasks)
        ? (targetEntity.metadata.subtasks as Subtask[])
        : []
      const updated = subs.map((s) => {
        if (s.id !== subtaskId) return s
        return { ...s, notes: (s.notes ?? []).map((n) => n.id === noteId ? { ...n, text } : n) }
      })
      update.mutate({
        id: targetEntity.id,
        updates: { metadata: { ...targetEntity.metadata, subtasks: updated }, updatedAt: new Date().toISOString() },
      })
    },
    [update],
  )

  // Add subtask to any entity
  const addSubtask = useCallback(
    (targetEntity: Entity, title: string) => {
      const existing = Array.isArray(targetEntity.metadata.subtasks)
        ? (targetEntity.metadata.subtasks as Subtask[])
        : []
      const newSub: Subtask = { id: crypto.randomUUID(), title, done: false, status: 'todo' }
      update.mutate({
        id: targetEntity.id,
        updates: {
          metadata: { ...targetEntity.metadata, subtasks: [...existing, newSub] },
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [update],
  )

  const openTaskDetail = useCallback((entity: Entity) => {
    setDetailTask(entity)
    setDetailOpen(true)
  }, [])

  const handleDetailUpdate = useCallback((id: string, updates: Partial<Entity>) => {
    update.mutate({ id, updates })
  }, [update])

  const handleDetailDelete = useCallback((entity: Entity) => {
    removeEntity.mutate(entity.id)
    setDetailOpen(false)
  }, [removeEntity])

  const todayFocusMinutes = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0]
    return allTrackers
      .filter((t) => t.unit === 'focus-min' && t.timestamp.startsWith(todayStr))
      .reduce((sum, t) => sum + t.value, 0)
  }, [allTrackers])

  const handlePause = () => pauseTimer()
  const handleResume = () => resumeTimer()
  const handleSkip = () => handleTimerEndRef.current()
  const handleStartWork = () => setPhase('work')

  const timerProgress = totalDuration > 0 ? ((totalDuration - secondsLeft) / totalDuration) * 100 : 0
  const phaseLabel = phase === 'work' ? 'Focus' : phase === 'break' ? 'Break' : phase === 'long-break' ? 'Long Break' : 'Ready'
  const style = PHASE_STYLES[phase]

  // No focus tasks — show Session Planner or manual fallback.
  //
  // A session can be open here. `emperorEntityIds` is never pruned, so if the tasks it points at
  // are deleted, archived, or simply have not loaded yet, this branch renders instead of the
  // timer — while the sidebar, the tab title and Today all still say a session is running,
  // because their predicate is `sessionId && emperorEntityIds.length`. Every control that could
  // end it lives below this return, so the session became genuinely unkillable from the UI: the
  // only way out was to clear localStorage.
  //
  // It cannot prune the ids to fix this — `allEntities` is also empty while the query is loading
  // or logged out, and pruning then would throw away a live session. So it offers the exit
  // instead and says plainly what is going on.
  if (emperorEntities.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-[#0a0a0f]">
        {!plannerSkipped ? (
          <SessionPlanner
            onStartSession={(entityIds) => {
              startEmperorTime(entityIds)
            }}
            onSkip={() => setPlannerSkipped(true)}
          />
        ) : (
          <div className="text-center space-y-4">
            <Crown className="h-10 w-10 mx-auto text-amber-500/30" />
            <h2 className="text-lg font-semibold text-zinc-200">No focus tasks set</h2>
            <p className="text-sm text-zinc-500">Pick your focus for today first, then enter Emperor Time.</p>
            <Button variant="outline" onClick={() => navigate('/')} className="border-zinc-800 text-zinc-300 hover:bg-zinc-900">
              Back to Today
            </Button>
          </div>
        )}

        {sessionId && (
          <div className="text-center space-y-2">
            <p className="text-xs text-zinc-600">
              A session is still open, but the tasks it was for are gone.
            </p>
            <button
              onClick={handleEnd}
              className="text-xs text-zinc-500 underline-offset-4 hover:text-red-400 hover:underline focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:outline-none cursor-pointer"
            >
              End session
            </button>
          </div>
        )}
      </div>
    )
  }

  // ─── Emperor Time ───
  return (
    <div className={`min-h-screen flex flex-col transition-colors duration-700 ${style.bg}`}>
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4">
        <button
          onClick={handleLeave}
          className="p-2 rounded-lg hover:bg-white/5 transition-colors text-zinc-600 hover:text-zinc-400 cursor-pointer"
          title="Leave (Esc) — session stays active"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs font-medium tracking-wider uppercase text-amber-500/70">
            <Crown className="h-3.5 w-3.5" />
            Emperor Time
          </span>
          <span className="w-px h-3 bg-zinc-800" />
          <span className={`text-xs font-medium ${style.accent}`}>{phaseLabel}</span>
          <span className="w-px h-3 bg-zinc-800" />
          <span className="text-xs text-zinc-600 tabular-nums">
            {currentSession}/{settings.sessionsBeforeLongBreak}
          </span>
          <span className="w-px h-3 bg-zinc-800" />
          {phase === 'work' && (
            <button
              onClick={() => setDistractions((d) => d + 1)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-white/5 transition-colors text-zinc-600 hover:text-zinc-400 cursor-pointer text-xs tabular-nums"
              title="Log a distraction"
            >
              <Zap className="h-3 w-3" />
              {distractions > 0 && <span>{distractions}</span>}
            </button>
          )}
          <span className="w-px h-3 bg-zinc-800" />
          <button
            onClick={() => useUiStore.getState().openCommandBar('/')}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-zinc-600 hover:text-zinc-400 cursor-pointer"
            title="Quick Capture (⌘⇧I)"
          >
            <Inbox className="h-4 w-4" />
          </button>
          <button
            onClick={() => window.open('/briefing', '_blank')}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-zinc-600 hover:text-zinc-400 cursor-pointer"
            title="Standup Briefing (⌘⇧B)"
          >
            <Presentation className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Tab-away welcome back */}
      {tabAway && (
        <div className="flex items-center justify-center gap-3 py-2 bg-amber-500/10 border-b border-amber-500/20">
          <span className="text-xs text-amber-400">Paused — you switched away</span>
          <Button size="sm" variant="outline" className="h-6 px-3 text-xs border-amber-500/30 text-amber-400 hover:bg-amber-500/10" onClick={() => { resumeTimer(); setTabAway(false) }}>
            Resume
          </Button>
        </div>
      )}

      <div className="flex-1 flex flex-col items-center justify-center px-4 max-w-2xl mx-auto w-full gap-8">
        {/* Timer ring */}
        <div className="relative flex flex-col items-center gap-6">
          {/* Glow behind timer */}
          <div className={`absolute inset-0 -m-12 rounded-full bg-gradient-radial ${style.ring} blur-3xl opacity-60 pointer-events-none`} />

          <div className={`relative text-7xl font-light tabular-nums tracking-tight select-none ${style.timerColor}`}>
            {phase === 'idle' ? `${settings.workMinutes}:00` : formatTime(secondsLeft)}
          </div>

          {/* Progress track */}
          <div className={`relative w-72 h-1 rounded-full ${style.trackBg} overflow-hidden`}>
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-all duration-1000 ease-linear ${style.trackFill}`}
              style={{ width: `${timerProgress}%` }}
            />
          </div>

          {/* Session goal reminder */}
          {sessionGoal && phase === 'work' && (
            <p className="text-xs text-zinc-500 italic">{sessionGoal}</p>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {phase === 'idle' ? (
            <div className="flex flex-col items-center gap-3">
              <input
                type="text"
                value={sessionGoal}
                onChange={(e) => setSessionGoal(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && sessionGoal.trim()) handleStartWork() }}
                placeholder="Session goal (optional)"
                className="w-64 bg-transparent border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:border-amber-500/40 text-center"
              />
              <Button
                onClick={handleStartWork}
                size="lg"
                className="gap-2 bg-amber-500 hover:bg-amber-400 text-black font-medium rounded-full px-8"
              >
                <Play className="h-4 w-4" />
                Start Focus
              </Button>
              {/* The way out of an idle session.
                  A session is open whenever `sessionId` is set, but the timer sits at `idle`
                  three times over its life: the moment Emperor Time starts, after a break
                  finishes, and after a work block when auto-start-break is off. The End button
                  used to live only in the running branch, so in all three the sidebar said a
                  session was running and this page offered no way to stop it — the only exit was
                  to start a block you did not want in order to end it. Quiet, because the
                  primary action here is still Start Focus. */}
              {sessionId && (
                <button
                  onClick={handleEnd}
                  className="text-xs text-zinc-600 underline-offset-4 hover:text-red-400 hover:underline focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:outline-none cursor-pointer"
                >
                  End session
                </button>
              )}
            </div>
          ) : (
            <>
              {isRunning ? (
                <button onClick={handlePause} className="h-12 w-12 rounded-full border border-zinc-700 flex items-center justify-center hover:bg-white/5 transition-colors text-zinc-400 hover:text-zinc-200 cursor-pointer">
                  <Pause className="h-5 w-5" />
                </button>
              ) : (
                <button onClick={handleResume} className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors cursor-pointer ${phase === 'work' ? 'bg-amber-500 hover:bg-amber-400 text-black' : phase === 'break' ? 'bg-emerald-500 hover:bg-emerald-400 text-black' : 'bg-sky-500 hover:bg-sky-400 text-black'}`}>
                  <Play className="h-5 w-5" />
                </button>
              )}
              <button onClick={handleSkip} className="h-10 w-10 rounded-full border border-zinc-800 flex items-center justify-center hover:bg-white/5 transition-colors text-zinc-500 hover:text-zinc-300 cursor-pointer">
                <SkipForward className="h-4 w-4" />
              </button>
              <button onClick={handleEnd} className="h-10 w-10 rounded-full border border-red-900/50 flex items-center justify-center hover:bg-red-500/10 transition-colors text-red-500/60 hover:text-red-400 cursor-pointer" title="End session">
                <Square className="h-4 w-4" />
              </button>
            </>
          )}
        </div>

        {completedSessions > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Flame className="h-3.5 w-3.5 text-orange-500/70" />
            {completedSessions} session{completedSessions !== 1 ? 's' : ''}
          </div>
        )}

        {/* Focus tasks */}
        <div className="w-full space-y-2 mt-2">
          {emperorEntities.map((item) => {
            const subs = Array.isArray(item.metadata.subtasks) ? (item.metadata.subtasks as Subtask[]) : []
            const doneCount = subs.filter((s) => stDone(s)).length
            const inProgressCount = subs.filter((s) => stStatus(s) === 'in-progress').length
            const isActive = item.id === activeEntityId
            const allDone = item.status === 'done' || (subs.length > 0 && subs.every((s) => stDone(s)))

            return (
              <div
                key={item.id}
                className={`rounded-xl transition-all duration-300 relative group/task ${
                  isActive
                    ? 'bg-white/[0.04] border border-zinc-700/50 shadow-lg shadow-black/20'
                    : allDone
                      ? 'bg-white/[0.01] border border-zinc-800/30 opacity-40'
                      : 'bg-white/[0.02] border border-zinc-800/40 hover:bg-white/[0.04] hover:border-zinc-700/50'
                }`}
              >
                {/* Story header */}
                <button
                  onClick={() => {
                    if (!allDone) useFocusStore.setState({ activeEntityId: item.id })
                  }}
                  className="flex items-center gap-3 w-full p-3.5 text-left cursor-pointer"
                >
                  {isActive && <ChevronRight className="h-4 w-4 text-amber-500/70 shrink-0" />}
                  <InlineEdit
                    value={item.title}
                    onSave={(v) => renameEntity(item, v)}
                    className={`text-sm font-medium truncate ${allDone ? 'line-through text-zinc-600' : 'text-zinc-200'}`}
                  />
                  {typeof item.metadata.workspace === 'string' && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${
                      item.metadata.workspace === 'work'
                        ? 'bg-blue-500/10 text-blue-400/70'
                        : 'bg-emerald-500/10 text-emerald-400/70'
                    }`}>
                      {item.metadata.workspace === 'work' ? 'Work' : 'Personal'}
                    </span>
                  )}
                  {subs.length > 0 && (
                    <span className={`text-xs tabular-nums shrink-0 ${allDone ? 'text-emerald-500/50' : 'text-zinc-500'}`}>
                      {doneCount}/{subs.length}
                      {inProgressCount > 0 && <span className="text-amber-500/60 ml-1">({inProgressCount} wip)</span>}
                    </span>
                  )}
                </button>
                {/* Open full detail panel */}
                <button
                  onClick={(e) => { e.stopPropagation(); openTaskDetail(item) }}
                  className="absolute top-3 right-3 text-zinc-700 hover:text-zinc-400 transition-colors cursor-pointer opacity-0 group-hover/task:opacity-100"
                  title="Open detail"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>

                {/* Subtasks + quick add — drag to reorder */}
                {isActive && (
                  <div className="px-3.5 pb-3.5 space-y-0.5">
                    <DndContext
                      sensors={dndSensors}
                      collisionDetection={closestCenter}
                      onDragEnd={(e) => handleSubtaskDragEnd(item, e)}
                    >
                      <SortableContext items={subs.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                        {subs.map((sub, i) => (
                          <SortableEmperorSubtask
                            key={sub.id}
                            sub={sub}
                            isCurrent={stStatus(sub) !== 'done' && i === subs.findIndex((s) => stStatus(s) !== 'done')}
                            item={item}
                            onToggle={toggleSubtask}
                            onRename={renameSubtask}
                            onAddNote={addSubtaskNote}
                            onRemoveNote={removeSubtaskNote}
                            onEditNote={editSubtaskNote}
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                    <QuickAddSubtask onAdd={(title) => addSubtask(item, title)} />
                    <QuickNote entity={item} onUpdate={(id, updates) => update.mutate({ id, updates })} />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Session history log */}
        <SessionHistoryPanel
          sessionId={sessionId}
          trackers={allTrackers}
          entityTitles={entityTitles}
          onUpdate={handleUpdateLog}
          onDelete={handleDeleteLog}
        />
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-center gap-6 px-6 py-4 border-t border-zinc-800/50">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600">Preset</span>
          <Select value={preset} onValueChange={(v) => setPreset(v as 'classic' | 'deep' | 'sprint')}>
            <SelectTrigger className="h-7 w-28 text-xs bg-transparent border-zinc-800 text-zinc-400 hover:border-zinc-700">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-zinc-800">
              <SelectItem value="classic">Classic (25m)</SelectItem>
              <SelectItem value="deep">Deep (50m)</SelectItem>
              <SelectItem value="sprint">Sprint (90m)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <span className="w-px h-3 bg-zinc-800" />
        <span className="text-xs text-zinc-600 tabular-nums">
          {completedSessions} session{completedSessions !== 1 ? 's' : ''}
        </span>
        <span className="w-px h-3 bg-zinc-800" />
        <span className="text-xs text-zinc-500 tabular-nums flex items-center gap-1.5">
          <Timer className="h-3 w-3 text-zinc-600" />
          {formatMinutes(todayFocusMinutes)} today
        </span>
      </div>

      {/* Task detail drawer */}
      <TaskDetailPanel
        task={detailTask}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onUpdate={handleDetailUpdate}
        onDelete={handleDetailDelete}
        allTasks={allEntities}
      />
      {/* Deep Work renders outside AppLayout, so it mounts the palette itself. */}
      <CommandBar />
      {sessionId && (
        <LyraCoach
          phase={phase}
          completedSessions={completedSessions}
          entityIds={emperorEntityIds}
        />
      )}
      {showReflection && (
        <SessionReflection onDismiss={() => setShowReflection(false)} />
      )}
    </div>
  )
}
