import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router'
import {
  ClipboardCopy,
  Check,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ChevronsUp,
  Minus,
  MessageSquare,
  Send,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { useEntities } from '@/core/hooks'
import { getSubtasks, subtaskDone, subtaskStatus, getLastWorkday } from './task-helpers'
import { getTodayPriorities } from '@/pages/today/today-helpers'
import { CaptureBar } from '@/pages/today/capture-bar'
import { filterNoteTemplates, type NoteTemplate } from '@/core/config/capture-protocol'
import type { Entity, EntityPriority } from '@/core/types'
import { isTask } from '@/core/types'

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface TaskNote {
  id: string
  text: string
  timestamp: string
}

function getNotes(metadata: Record<string, unknown>): TaskNote[] {
  return Array.isArray(metadata.notes) ? (metadata.notes as TaskNote[]) : []
}

function getRecentNotes(task: Entity, since: Date): TaskNote[] {
  return getNotes(task.metadata).filter((n) => new Date(n.timestamp) >= since)
}

function getRecentSubtaskNotes(task: Entity, since: Date): { subtaskTitle: string; note: TaskNote }[] {
  const subs = Array.isArray(task.metadata.subtasks) ? (task.metadata.subtasks as { title: string; notes?: TaskNote[] }[]) : []
  const result: { subtaskTitle: string; note: TaskNote }[] = []
  for (const s of subs) {
    for (const n of (s.notes ?? [])) {
      if (new Date(n.timestamp) >= since) result.push({ subtaskTitle: s.title, note: n })
    }
  }
  return result
}

type StandupWorkspace = 'all' | 'work' | 'personal'

// ---------------------------------------------------------------------------
// Jira-style priority icon
// ---------------------------------------------------------------------------

const PRIORITY_BORDER: Record<EntityPriority, string> = {
  urgent: 'border-l-red-500',
  high: 'border-l-orange-500',
  medium: 'border-l-yellow-500',
  low: 'border-l-blue-400',
}

function PriorityIcon({ priority, size = 14 }: { priority?: EntityPriority | null; size?: number }) {
  if (!priority) return null
  switch (priority) {
    case 'urgent':
      return <ChevronsUp style={{ width: size, height: size }} className="text-red-500 shrink-0" />
    case 'high':
      return <ArrowUp style={{ width: size, height: size }} className="text-orange-500 shrink-0" />
    case 'medium':
      return <Minus style={{ width: size, height: size }} className="text-yellow-500 shrink-0" />
    case 'low':
      return <ArrowDown style={{ width: size, height: size }} className="text-blue-400 shrink-0" />
  }
}

// ---------------------------------------------------------------------------
// Jira-style status icon
// ---------------------------------------------------------------------------

function StatusIcon({ status, done }: { status: 'todo' | 'in-progress' | 'done'; done: boolean }) {
  if (done || status === 'done') {
    return (
      <div className="h-[18px] w-[18px] rounded-[4px] bg-green-500 flex items-center justify-center shrink-0">
        <Check className="h-3 w-3 text-white" strokeWidth={3} />
      </div>
    )
  }
  if (status === 'in-progress') {
    return (
      <div className="h-[18px] w-[18px] rounded-[4px] border-2 border-blue-500 bg-blue-500/10 flex items-center justify-center shrink-0">
        <div className="h-2 w-2 rounded-full bg-blue-500" />
      </div>
    )
  }
  return (
    <div className="h-[18px] w-[18px] rounded-[4px] border-2 border-muted-foreground/25 shrink-0" />
  )
}

// ---------------------------------------------------------------------------
// Markdown generator (clipboard)
// ---------------------------------------------------------------------------

function buildMarkdown(
  done: Entity[],
  inProgressWithDoneSubs: Entity[],
  planInProgress: Entity[],
  plan: Entity[],
  blocked: Entity[],
  lastWorkday: Date,
  sinceLabel: string,
): string {
  const today = new Date()
  const dateLine = today.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
  const pChar = (p: EntityPriority) => p === 'urgent' ? '⬆⬆' : p === 'high' ? '⬆' : p === 'medium' ? '—' : '⬇'
  const lines: string[] = [`# Standup — ${dateLine}`, '']

  const hasLatest = done.length > 0 || inProgressWithDoneSubs.length > 0
  lines.push(`## Since ${sinceLabel}`)
  lines.push('')
  if (!hasLatest) {
    lines.push('No updates.')
  } else {
    const latestAll = [...done, ...inProgressWithDoneSubs]
    latestAll.forEach((t, i) => {
      const subs = getSubtasks(t.metadata)
      const doneSubs = subs.filter((s) => subtaskDone(s))
      const isDone = t.status === 'done'
      if (isDone) {
        lines.push(`${i + 1}. ${pChar(t.priority)} ~~${t.title}~~`)
      } else {
        lines.push(`${i + 1}. ${pChar(t.priority)} **${t.title}** (${doneSubs.length}/${subs.length})`)
      }
      doneSubs.forEach((s, si) => {
        const sp = (s.priority as EntityPriority | undefined) ?? t.priority
        lines.push(`   ${si + 1}. ${pChar(sp)} [x] ${s.title}`)
      })
      appendNotes(lines, t, lastWorkday)
    })
  }

  lines.push('')
  lines.push('## Today')
  lines.push('')
  if (planInProgress.length === 0 && plan.length === 0) {
    lines.push('No tasks planned.')
  } else {
    const todayAll = [...planInProgress, ...plan]
    todayAll.forEach((t, i) => {
      const subs = getSubtasks(t.metadata)
      const pendingSubs = subs.filter((s) => !subtaskDone(s))
      const doneSubs = subs.filter((s) => subtaskDone(s))
      if (pendingSubs.length > 0) {
        lines.push(`${i + 1}. ${pChar(t.priority)} **${t.title}** (${doneSubs.length}/${subs.length})`)
        pendingSubs.forEach((s, si) => {
          const st = subtaskStatus(s)
          const sp = (s.priority as EntityPriority | undefined) ?? t.priority
          lines.push(`   ${si + 1}. ${pChar(sp)} [${st === 'done' ? 'x' : ' '}] ${s.title}${st === 'in-progress' ? ' *(wip)*' : ''}`)
        })
      } else {
        lines.push(`${i + 1}. ${pChar(t.priority)} ${t.title}`)
      }
      appendNotes(lines, t, lastWorkday)
    })
  }

  if (blocked.length > 0) {
    lines.push('')
    lines.push('## Blockers')
    lines.push('')
    blocked.forEach((t, i) => lines.push(`${i + 1}. ${pChar(t.priority)} ${t.title}`))
  }

  return lines.join('\n')
}

function appendNotes(lines: string[], task: Entity, since: Date) {
  const recent = getRecentNotes(task, since)
  for (const n of recent) lines.push(`   > ${n.text}`)
  const subNotes = getRecentSubtaskNotes(task, since)
  for (const { subtaskTitle, note } of subNotes) lines.push(`   > _${subtaskTitle}_ — ${note.text}`)
}

// ---------------------------------------------------------------------------
// Visual render
// ---------------------------------------------------------------------------

interface NoteActions {
  onAddNote: (taskId: string, text: string, subtaskId?: string) => void
  onEditNote: (taskId: string, noteId: string, text: string, subtaskId?: string) => void
  onDeleteNote: (taskId: string, noteId: string, subtaskId?: string) => void
}

function NoteItem({
  note,
  taskId,
  subtaskId,
  actions,
}: {
  note: TaskNote
  taskId: string
  subtaskId?: string
  actions: NoteActions
}) {
  const [editing, setEditing] = useState(false)
  const [editVal, setEditVal] = useState(note.text)
  const editRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) editRef.current?.focus()
  }, [editing])

  const handleSave = () => {
    const text = editVal.trim()
    if (!text) return
    actions.onEditNote(taskId, note.id, text, subtaskId)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          ref={editRef}
          value={editVal}
          onChange={(e) => setEditVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave()
            if (e.key === 'Escape') { setEditing(false); setEditVal(note.text) }
          }}
          className="flex-1 text-[13px] bg-transparent border-b border-primary/40 outline-none py-0.5 italic text-muted-foreground/60"
        />
        <button onClick={handleSave} className="p-0.5 text-muted-foreground/40 hover:text-foreground cursor-pointer"><Check className="h-3 w-3" /></button>
        <button onClick={() => { setEditing(false); setEditVal(note.text) }} className="p-0.5 text-muted-foreground/40 hover:text-foreground cursor-pointer"><X className="h-3 w-3" /></button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1 group/note">
      <p className="text-[13px] text-muted-foreground/60 italic leading-snug flex-1">{note.text}</p>
      <button
        onClick={() => setEditing(true)}
        className="p-0.5 text-muted-foreground/30 hover:text-foreground opacity-0 group-hover/note:opacity-100 transition-opacity cursor-pointer"
      ><Pencil className="h-2.5 w-2.5" /></button>
      <button
        onClick={() => actions.onDeleteNote(taskId, note.id, subtaskId)}
        className="p-0.5 text-muted-foreground/30 hover:text-destructive opacity-0 group-hover/note:opacity-100 transition-opacity cursor-pointer"
      ><Trash2 className="h-2.5 w-2.5" /></button>
    </div>
  )
}

function NoteInput({
  onSubmit,
  placeholder = '/ templates — capture a note...',
}: {
  onSubmit: (text: string) => void
  placeholder?: string
}) {
  const [val, setVal] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [showTemplates, setShowTemplates] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const templates = filterNoteTemplates(val.trim())
  const hasTemplates = showTemplates && templates.length > 0

  useEffect(() => {
    if (open) ref.current?.focus()
  }, [open])

  useEffect(() => {
    setSelectedIdx(0)
  }, [templates.length])

  useEffect(() => {
    const trimmed = val.trim()
    setShowTemplates(trimmed.startsWith('/') && !trimmed.includes(' '))
  }, [val])

  useEffect(() => {
    if (!hasTemplates || !listRef.current) return
    const el = listRef.current.querySelector(`[data-tidx="${selectedIdx}"]`) as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx, hasTemplates])

  const selectTemplate = (t: NoteTemplate) => {
    setVal(t.insert)
    setShowTemplates(false)
    ref.current?.focus()
  }

  const handleSubmit = () => {
    const text = val.trim()
    if (!text) return
    onSubmit(text)
    setVal('')
    setOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (hasTemplates) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx((i) => Math.min(i + 1, templates.length - 1))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectTemplate(templates[selectedIdx])
        return
      }
    }
    if (e.key === 'Enter') handleSubmit()
    if (e.key === 'Escape') {
      if (showTemplates) {
        setShowTemplates(false)
      } else {
        setOpen(false); setVal('')
      }
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-muted-foreground/30 hover:text-foreground transition-colors cursor-pointer"
        title="Add note"
      >
        <MessageSquare className="h-3.5 w-3.5" />
      </button>
    )
  }

  return (
    <div className="relative flex items-center gap-2 mt-1">
      <input
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setShowTemplates(false), 150)}
        onFocus={() => {
          const trimmed = val.trim()
          if (trimmed.startsWith('/') && !trimmed.includes(' ')) setShowTemplates(true)
        }}
        placeholder={placeholder}
        className="flex-1 text-[13px] bg-transparent border-b border-muted-foreground/20 focus:border-primary/50 outline-none py-1 placeholder:text-muted-foreground/30 transition-colors"
      />
      <button
        onClick={handleSubmit}
        disabled={!val.trim()}
        className="p-1 rounded text-muted-foreground/40 hover:text-foreground disabled:opacity-30 transition-colors cursor-pointer"
      ><Send className="h-3.5 w-3.5" /></button>
      <button
        onClick={() => { setOpen(false); setVal('') }}
        className="p-1 rounded text-muted-foreground/40 hover:text-foreground transition-colors cursor-pointer"
      ><X className="h-3.5 w-3.5" /></button>

      {/* Note template suggestions — dropup from inline input */}
      {hasTemplates && (
        <div
          ref={listRef}
          className="absolute left-0 right-0 bottom-full mb-1 max-h-[240px] overflow-y-auto rounded-lg border bg-popover shadow-lg z-50"
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 bg-popover/95 backdrop-blur-sm border-b border-border/30">
            📋 Note Templates
          </div>
          {templates.map((t, idx) => {
            const isSelected = idx === selectedIdx
            return (
              <button
                key={t.command}
                data-tidx={idx}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectTemplate(t)}
                onMouseEnter={() => setSelectedIdx(idx)}
                className={`w-full flex items-center gap-3 px-3 py-1.5 text-left text-sm transition-colors ${
                  isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
                }`}
              >
                <span className="text-base shrink-0 w-5 text-center">{t.emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-primary">{t.command}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground/60 truncate">{t.description}</p>
                </div>
                {isSelected && (
                  <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/50 font-mono shrink-0">↵</kbd>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TaskCard({
  task,
  variant,
  lastWorkday,
  index,
  actions,
  children,
}: {
  task: Entity
  variant: 'done' | 'progress' | 'plan'
  lastWorkday: Date
  index: number
  actions?: NoteActions
  children?: React.ReactNode
}) {
  const isDone = variant === 'done'
  const subs = getSubtasks(task.metadata)
  const doneSubs = subs.filter((s) => subtaskDone(s))
  const hasSubs = subs.length > 0
  const taskNotes = getRecentNotes(task, lastWorkday)

  return (
    <div className={`rounded-lg border-l-[3px] ${PRIORITY_BORDER[task.priority]} ${
      isDone ? 'bg-muted/20' : 'bg-card'
    } px-4 py-3 group/card`}>
      {/* Title row */}
      <div className="flex items-center gap-2.5">
        <span className="text-[13px] font-semibold text-muted-foreground/40 tabular-nums w-5 shrink-0">{index}.</span>
        <PriorityIcon priority={task.priority} size={16} />
        <p className={`text-[15px] leading-snug flex-1 ${
          isDone ? 'line-through text-muted-foreground decoration-muted-foreground/30' : 'font-medium text-foreground'
        }`}>
          {task.title}
        </p>
        {hasSubs && (
          <span className="text-xs text-muted-foreground/40 tabular-nums font-medium shrink-0">{doneSubs.length}/{subs.length}</span>
        )}
        {actions && (
          <div className={`shrink-0 ${taskNotes.length > 0 ? '' : 'opacity-0 group-hover/card:opacity-100'} transition-opacity`}>
            <NoteInput onSubmit={(text) => actions.onAddNote(task.id, text)} />
          </div>
        )}
      </div>

      {/* Task-level notes with edit/delete */}
      {taskNotes.length > 0 && (
        <div className="mt-1.5 ml-8 space-y-0.5 border-l-2 border-muted pl-2.5">
          {taskNotes.map((n) =>
            actions ? (
              <NoteItem key={n.id} note={n} taskId={task.id} actions={actions} />
            ) : (
              <p key={n.id} className="text-[13px] text-muted-foreground/60 italic leading-snug">{n.text}</p>
            ),
          )}
        </div>
      )}

      {children && <div className="mt-2.5 ml-8 space-y-0">{children}</div>}
    </div>
  )
}

function SubtaskRow({
  title,
  subtaskId,
  taskId,
  status,
  done: isDone,
  priority,
  notes,
  index,
  actions,
}: {
  title: string
  subtaskId: string
  taskId: string
  status: 'todo' | 'in-progress' | 'done'
  done: boolean
  priority?: EntityPriority | null
  notes?: TaskNote[]
  index: number
  actions?: NoteActions
}) {
  return (
    <div className="py-[2px] group/sub">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground/30 tabular-nums w-4 shrink-0 text-right">{index}.</span>
        <StatusIcon status={status} done={isDone} />
        <PriorityIcon priority={priority} size={14} />
        <span className={`text-[13px] leading-snug flex-1 ${
          isDone ? 'line-through text-muted-foreground decoration-muted-foreground/20' :
          status === 'in-progress' ? 'text-foreground font-medium' :
          'text-foreground/70'
        }`}>
          {title}
        </span>
        {actions && (
          <div className={`shrink-0 ${(notes?.length ?? 0) > 0 ? '' : 'opacity-0 group-hover/sub:opacity-100'} transition-opacity`}>
            <NoteInput
              onSubmit={(text) => actions.onAddNote(taskId, text, subtaskId)}
              placeholder="Note on subtask..."
            />
          </div>
        )}
      </div>
      {notes && notes.length > 0 && (
        <div className="ml-[42px] mt-0.5 mb-1 space-y-0.5 border-l-2 border-muted pl-2.5">
          {notes.map((n) =>
            actions ? (
              <NoteItem key={n.id} note={n} taskId={taskId} subtaskId={subtaskId} actions={actions} />
            ) : (
              <p key={n.id} className="text-[12px] text-muted-foreground/50 italic leading-snug">{n.text}</p>
            ),
          )}
        </div>
      )}
    </div>
  )
}

function StandupRender({
  done,
  inProgressWithDoneSubs,
  planInProgress,
  plan,
  blocked,
  lastWorkday,
  sinceLabel,
  actions,
}: {
  done: Entity[]
  inProgressWithDoneSubs: Entity[]
  planInProgress: Entity[]
  plan: Entity[]
  blocked: Entity[]
  lastWorkday: Date
  sinceLabel: string
  actions: NoteActions
}) {
  const hasLatest = done.length > 0 || inProgressWithDoneSubs.length > 0

  return (
    <div className="grid grid-cols-2 gap-12 py-2">
      {/* Left: Latest */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/40">Since {sinceLabel}</span>
          <div className="flex-1 h-px bg-border" />
        </div>
        {!hasLatest ? (
          <p className="text-base text-muted-foreground/30">No updates.</p>
        ) : (
          <div className="space-y-3">
            {[...done, ...inProgressWithDoneSubs].map((t, i) => {
              const subs = getSubtasks(t.metadata)
              const doneSubs = subs.filter((s) => subtaskDone(s))
              const isDone = t.status === 'done'
              return (
                <TaskCard key={t.id} task={t} variant={isDone ? 'done' : 'progress'} lastWorkday={lastWorkday} index={i + 1} actions={actions}>
                  {doneSubs.length > 0 && doneSubs.map((s, si) => (
                    <SubtaskRow key={s.id} subtaskId={s.id} taskId={t.id} title={s.title} status="done" done priority={(s.priority as EntityPriority | undefined) ?? t.priority} notes={(s.notes as TaskNote[] | undefined)?.filter((n) => new Date(n.timestamp) >= lastWorkday)} index={si + 1} actions={actions} />
                  ))}
                </TaskCard>
              )
            })}
          </div>
        )}
      </section>

      {/* Right: Today */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/40">Today</span>
          <div className="flex-1 h-px bg-border" />
        </div>
        {planInProgress.length === 0 && plan.length === 0 ? (
          <p className="text-base text-muted-foreground/30">No tasks planned.</p>
        ) : (
          <div className="space-y-3">
            {[...planInProgress, ...plan].map((t, i) => {
              const subs = getSubtasks(t.metadata)
              const pendingSubs = subs.filter((s) => !subtaskDone(s))
              const hasPending = pendingSubs.length > 0
              return (
                <TaskCard key={t.id} task={t} variant="plan" lastWorkday={lastWorkday} index={i + 1} actions={actions}>
                  {hasPending && pendingSubs.map((s, si) => {
                    const st = subtaskStatus(s)
                    return <SubtaskRow key={s.id} subtaskId={s.id} taskId={t.id} title={s.title} status={st} done={false} priority={(s.priority as EntityPriority | undefined) ?? t.priority} notes={(s.notes as TaskNote[] | undefined)?.filter((n) => new Date(n.timestamp) >= lastWorkday)} index={si + 1} actions={actions} />
                  })}
                </TaskCard>
              )
            })}
          </div>
        )}
      </section>

      {/* Blockers — full width */}
      {blocked.length > 0 && (
        <section className="col-span-2">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-semibold uppercase tracking-widest text-destructive/50">Blockers</span>
            <div className="flex-1 h-px bg-destructive/20" />
          </div>
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 space-y-1.5">
            {blocked.map((t, i) => (
              <div key={t.id} className="flex items-center gap-2.5">
                <span className="text-[13px] font-semibold text-destructive/40 tabular-nums w-5 shrink-0">{i + 1}.</span>
                <PriorityIcon priority={t.priority} size={16} />
                <p className="text-[15px]">{t.title}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Full-screen page
// ---------------------------------------------------------------------------

export function BriefingPage({ embedded }: { embedded?: boolean }) {
  const navigate = useNavigate()
  const [ws, setWs] = useState<StandupWorkspace>('all')
  const { items: allEntities, update } = useEntities()
  const tasks = useMemo(() => allEntities.filter((e: Entity) => isTask(e)), [allEntities])

  const todayPriorityIds = useMemo(() => getTodayPriorities(), [])

  const lastWorkday = useMemo(() => getLastWorkday(), [])
  const sinceLabel = useMemo(() => lastWorkday.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), [lastWorkday])

  const filtered = useMemo(() => {
    if (ws === 'all') return tasks
    return tasks.filter((t) => t.metadata.workspace === ws)
  }, [tasks, ws])

  const { done, inProgressWithDoneSubs, plan, planInProgress, blocked } = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]

    const doneTasks = filtered.filter(
      (t) => t.status === 'done' && t.updatedAt && new Date(t.updatedAt) >= lastWorkday,
    )

    const inProgressWithCompletedSubs = filtered.filter(
      (t) => t.status === 'in-progress' && getSubtasks(t.metadata).some((s) => subtaskDone(s)),
    )

    const prioritySet = new Set(todayPriorityIds)
    const planAll = filtered.filter(
      (t) =>
        t.status !== 'done' &&
        t.status !== 'archived' &&
        (prioritySet.has(t.id) || t.dueDate === today || t.priority === 'urgent' || t.priority === 'high'),
    )
    const planInProg = planAll.filter(
      (t) => getSubtasks(t.metadata).some((s) => !subtaskDone(s)),
    )
    const planInProgressIds = new Set(planInProg.map((t) => t.id))
    const planTopLevel = planAll.filter((t) => !planInProgressIds.has(t.id))
    const blockedTasks = filtered.filter((t) => t.status === 'in-progress')

    return { done: doneTasks, inProgressWithDoneSubs: inProgressWithCompletedSubs, plan: planTopLevel, planInProgress: planInProg, blocked: blockedTasks }
  }, [filtered, lastWorkday, todayPriorityIds])

  const markdown = useMemo(
    () => buildMarkdown(done, inProgressWithDoneSubs, planInProgress, plan, blocked, lastWorkday, sinceLabel),
    [done, inProgressWithDoneSubs, planInProgress, plan, blocked, lastWorkday, sinceLabel],
  )

  const copyToClipboard = () => {
    navigator.clipboard.writeText(markdown)
    notify({ title: 'Copied to clipboard', type: 'success' })
  }

  // Helpers to mutate task/subtask notes
  const getTask = useCallback((id: string) => allEntities.find((e) => e.id === id), [allEntities])

  const noteActions: NoteActions = useMemo(() => ({
    onAddNote: (taskId: string, text: string, subtaskId?: string) => {
      const task = getTask(taskId)
      if (!task) return
      const note: TaskNote = { id: crypto.randomUUID(), text, timestamp: new Date().toISOString() }
      if (subtaskId) {
        const subs = Array.isArray(task.metadata.subtasks) ? (task.metadata.subtasks as Record<string, unknown>[]) : []
        const updated = subs.map((s) =>
          (s as { id: string }).id === subtaskId
            ? { ...s, notes: [...(Array.isArray(s.notes) ? s.notes as TaskNote[] : []), note] }
            : s,
        )
        update.mutate({ id: taskId, updates: { metadata: { ...task.metadata, subtasks: updated }, updatedAt: new Date().toISOString() } })
      } else {
        const existing = Array.isArray(task.metadata.notes) ? (task.metadata.notes as TaskNote[]) : []
        update.mutate({ id: taskId, updates: { metadata: { ...task.metadata, notes: [...existing, note] }, updatedAt: new Date().toISOString() } })
      }
      notify({ title: 'Note captured', type: 'success' })
    },
    onEditNote: (taskId: string, noteId: string, text: string, subtaskId?: string) => {
      const task = getTask(taskId)
      if (!task) return
      if (subtaskId) {
        const subs = Array.isArray(task.metadata.subtasks) ? (task.metadata.subtasks as Record<string, unknown>[]) : []
        const updated = subs.map((s) =>
          (s as { id: string }).id === subtaskId
            ? { ...s, notes: (Array.isArray(s.notes) ? s.notes as TaskNote[] : []).map((n) => n.id === noteId ? { ...n, text } : n) }
            : s,
        )
        update.mutate({ id: taskId, updates: { metadata: { ...task.metadata, subtasks: updated }, updatedAt: new Date().toISOString() } })
      } else {
        const notes = (Array.isArray(task.metadata.notes) ? task.metadata.notes as TaskNote[] : []).map((n) => n.id === noteId ? { ...n, text } : n)
        update.mutate({ id: taskId, updates: { metadata: { ...task.metadata, notes }, updatedAt: new Date().toISOString() } })
      }
    },
    onDeleteNote: (taskId: string, noteId: string, subtaskId?: string) => {
      const task = getTask(taskId)
      if (!task) return
      if (subtaskId) {
        const subs = Array.isArray(task.metadata.subtasks) ? (task.metadata.subtasks as Record<string, unknown>[]) : []
        const updated = subs.map((s) =>
          (s as { id: string }).id === subtaskId
            ? { ...s, notes: (Array.isArray(s.notes) ? s.notes as TaskNote[] : []).filter((n) => n.id !== noteId) }
            : s,
        )
        update.mutate({ id: taskId, updates: { metadata: { ...task.metadata, subtasks: updated }, updatedAt: new Date().toISOString() } })
      } else {
        const notes = (Array.isArray(task.metadata.notes) ? task.metadata.notes as TaskNote[] : []).filter((n) => n.id !== noteId)
        update.mutate({ id: taskId, updates: { metadata: { ...task.metadata, notes }, updatedAt: new Date().toISOString() } })
      }
      notify({ title: 'Note deleted', type: 'success' })
    },
  }), [getTask, update])

  const today = new Date()
  const dateLine = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  if (embedded) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
            {(['all', 'work', 'personal'] as const).map((w) => (
              <button
                key={w}
                onClick={() => setWs(w)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  ws === w
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {w === 'all' ? 'All' : w === 'work' ? 'Work' : 'Personal'}
              </button>
            ))}
          </div>
          <Button onClick={copyToClipboard} variant="outline" size="sm" className="gap-1.5">
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy
          </Button>
        </div>
        <StandupRender
          done={done}
          inProgressWithDoneSubs={inProgressWithDoneSubs}
          planInProgress={planInProgress}
          plan={plan}
          blocked={blocked}
          lastWorkday={lastWorkday}
          sinceLabel={sinceLabel}
          actions={noteActions}
        />
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Header */}
      <header className="shrink-0 flex items-center justify-between px-8 py-5 border-b">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{dateLine}</h1>
            <p className="text-sm text-muted-foreground/50">Morning brief</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Priority legend */}
          <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground/40">
            <span className="flex items-center gap-0.5"><ChevronsUp className="h-3 w-3 text-red-500" />Urgent</span>
            <span className="flex items-center gap-0.5"><ArrowUp className="h-3 w-3 text-orange-500" />High</span>
            <span className="flex items-center gap-0.5"><Minus className="h-3 w-3 text-yellow-500" />Med</span>
            <span className="flex items-center gap-0.5"><ArrowDown className="h-3 w-3 text-blue-400" />Low</span>
          </div>

          {/* Workspace filter */}
          <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
            {(['all', 'work', 'personal'] as const).map((w) => (
              <button
                key={w}
                onClick={() => setWs(w)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  ws === w
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {w === 'all' ? 'All' : w === 'work' ? 'Work' : 'Personal'}
              </button>
            ))}
          </div>

          {/* Copy */}
          <Button onClick={copyToClipboard} variant="outline" size="sm" className="gap-2">
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy Markdown
          </Button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto px-8 py-6 max-w-7xl mx-auto w-full">
        <StandupRender
          done={done}
          inProgressWithDoneSubs={inProgressWithDoneSubs}
          planInProgress={planInProgress}
          plan={plan}
          blocked={blocked}
          lastWorkday={lastWorkday}
          sinceLabel={sinceLabel}
          actions={noteActions}
        />
      </main>

      {/* Bottom capture bar — dropup */}
      <footer className="shrink-0 border-t bg-background/95 backdrop-blur px-8 py-3">
        <div className="max-w-7xl mx-auto">
          <CaptureBar direction="up" noGlobalShortcut />
        </div>
      </footer>
    </div>
  )
}
