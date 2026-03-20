import { useState, useMemo } from 'react'
import {
  ClipboardCopy,
  Check,
  ArrowUp,
  ArrowDown,
  ChevronsUp,
  Minus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { notify } from '@/lib/notify'
import { getSubtasks, subtaskDone, subtaskStatus } from './task-helpers'
import type { Entity, EntityPriority } from '@/core/types'

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

interface StandupReportProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: Entity[]
  todayPriorityIds?: string[]
}

function getLastWorkday(): Date {
  const now = new Date()
  const day = now.getDay()
  const daysBack = day === 1 ? 3 : day === 0 ? 2 : 1
  const d = new Date(now)
  d.setDate(d.getDate() - daysBack)
  d.setHours(0, 0, 0, 0)
  return d
}

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
    for (const t of done) {
      const subs = getSubtasks(t.metadata)
      const doneSubs = subs.filter((s) => subtaskDone(s))
      lines.push(`- ${pChar(t.priority)} ~~${t.title}~~`)
      for (const s of doneSubs) {
        const sp = (s.priority as EntityPriority | undefined) ?? t.priority
        lines.push(`  - ${pChar(sp)} [x] ${s.title}`)
      }
      appendNotes(lines, t, lastWorkday)
    }
    for (const t of inProgressWithDoneSubs) {
      const subs = getSubtasks(t.metadata)
      const doneSubs = subs.filter((s) => subtaskDone(s))
      lines.push(`- ${pChar(t.priority)} **${t.title}** (${doneSubs.length}/${subs.length})`)
      for (const s of doneSubs) {
        const sp = (s.priority as EntityPriority | undefined) ?? t.priority
        lines.push(`  - ${pChar(sp)} [x] ${s.title}`)
      }
    }
  }

  lines.push('')
  lines.push('## Today')
  lines.push('')
  if (planInProgress.length === 0 && plan.length === 0) {
    lines.push('No tasks planned.')
  } else {
    for (const t of planInProgress) {
      const subs = getSubtasks(t.metadata)
      const pendingSubs = subs.filter((s) => !subtaskDone(s))
      const doneSubs = subs.filter((s) => subtaskDone(s))
      lines.push(`- ${pChar(t.priority)} **${t.title}** (${doneSubs.length}/${subs.length})`)
      for (const s of pendingSubs) {
        const st = subtaskStatus(s)
        const sp = (s.priority as EntityPriority | undefined) ?? t.priority
        lines.push(`  - ${pChar(sp)} [${st === 'done' ? 'x' : ' '}] ${s.title}${st === 'in-progress' ? ' *(wip)*' : ''}`)
      }
      appendNotes(lines, t, lastWorkday)
    }
    for (const t of plan) {
      lines.push(`- ${pChar(t.priority)} ${t.title}`)
      appendNotes(lines, t, lastWorkday)
    }
  }

  if (blocked.length > 0) {
    lines.push('')
    lines.push('## Blockers')
    lines.push('')
    for (const t of blocked) lines.push(`- ${pChar(t.priority)} ${t.title}`)
  }

  return lines.join('\n')
}

function appendNotes(lines: string[], task: Entity, since: Date) {
  const recent = getRecentNotes(task, since)
  for (const n of recent) lines.push(`  > ${n.text}`)
  const subNotes = getRecentSubtaskNotes(task, since)
  for (const { subtaskTitle, note } of subNotes) lines.push(`  > _${subtaskTitle}_ — ${note.text}`)
}

// ---------------------------------------------------------------------------
// Visual render
// ---------------------------------------------------------------------------

function TaskCard({
  task,
  variant,
  lastWorkday,
  children,
}: {
  task: Entity
  variant: 'done' | 'progress' | 'plan'
  lastWorkday: Date
  children?: React.ReactNode
}) {
  const isDone = variant === 'done'
  const subs = getSubtasks(task.metadata)
  const doneSubs = subs.filter((s) => subtaskDone(s))
  const hasSubs = subs.length > 0

  // Task-level notes only (not subtask notes — those render inline per subtask)
  const taskNotes = getRecentNotes(task, lastWorkday)

  return (
    <div className={`rounded-lg border-l-[3px] ${PRIORITY_BORDER[task.priority]} ${
      isDone ? 'bg-muted/20' : 'bg-card'
    } px-4 py-3`}>
      {/* Title row */}
      <div className="flex items-center gap-2.5">
        <PriorityIcon priority={task.priority} size={16} />
        <p className={`text-[15px] leading-snug flex-1 ${
          isDone ? 'line-through text-muted-foreground decoration-muted-foreground/30' : 'font-medium text-foreground'
        }`}>
          {task.title}
        </p>
        {hasSubs && (
          <span className="text-xs text-muted-foreground/40 tabular-nums font-medium shrink-0">{doneSubs.length}/{subs.length}</span>
        )}
      </div>

      {/* Task-level notes */}
      {taskNotes.length > 0 && (
        <div className="mt-1.5 ml-6 space-y-0.5 border-l-2 border-muted pl-2.5">
          {taskNotes.map((n) => (
            <p key={n.id} className="text-[13px] text-muted-foreground/60 italic leading-snug">{n.text}</p>
          ))}
        </div>
      )}

      {children && <div className="mt-2.5 ml-6 space-y-0">{children}</div>}
    </div>
  )
}

function SubtaskRow({
  title,
  status,
  done: isDone,
  priority,
  notes,
}: {
  title: string
  status: 'todo' | 'in-progress' | 'done'
  done: boolean
  priority?: EntityPriority | null
  notes?: TaskNote[]
}) {
  return (
    <div className="py-[2px]">
      <div className="flex items-center gap-2">
        <StatusIcon status={status} done={isDone} />
        <PriorityIcon priority={priority} size={14} />
        <span className={`text-[13px] leading-snug flex-1 ${
          isDone ? 'line-through text-muted-foreground decoration-muted-foreground/20' :
          status === 'in-progress' ? 'text-foreground font-medium' :
          'text-foreground/70'
        }`}>
          {title}
        </span>
      </div>
      {notes && notes.length > 0 && (
        <div className="ml-[34px] mt-0.5 mb-1 space-y-0.5 border-l-2 border-muted pl-2.5">
          {notes.map((n) => (
            <p key={n.id} className="text-[12px] text-muted-foreground/50 italic leading-snug">{n.text}</p>
          ))}
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
}: {
  done: Entity[]
  inProgressWithDoneSubs: Entity[]
  planInProgress: Entity[]
  plan: Entity[]
  blocked: Entity[]
  lastWorkday: Date
  sinceLabel: string
}) {
  const hasLatest = done.length > 0 || inProgressWithDoneSubs.length > 0

  return (
    <div className="grid grid-cols-2 gap-8 py-2">
      {/* Left: Latest */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/40">Since {sinceLabel}</span>
          <div className="flex-1 h-px bg-border" />
        </div>
        {!hasLatest ? (
          <p className="text-[15px] text-muted-foreground/30">No updates.</p>
        ) : (
          <div className="space-y-2.5">
            {done.map((t) => {
              const subs = getSubtasks(t.metadata)
              const doneSubs = subs.filter((s) => subtaskDone(s))
              return (
                <TaskCard key={t.id} task={t} variant="done" lastWorkday={lastWorkday}>
                  {doneSubs.length > 0 && doneSubs.map((s) => (
                    <SubtaskRow key={s.id} title={s.title} status="done" done priority={(s.priority as EntityPriority | undefined) ?? t.priority} notes={(s.notes as TaskNote[] | undefined)?.filter((n) => new Date(n.timestamp) >= lastWorkday)} />
                  ))}
                </TaskCard>
              )
            })}
            {inProgressWithDoneSubs.map((t) => {
              const subs = getSubtasks(t.metadata)
              const doneSubs = subs.filter((s) => subtaskDone(s))
              return (
                <TaskCard key={t.id} task={t} variant="progress" lastWorkday={lastWorkday}>
                  {doneSubs.map((s) => (
                    <SubtaskRow key={s.id} title={s.title} status="done" done priority={(s.priority as EntityPriority | undefined) ?? t.priority} notes={(s.notes as TaskNote[] | undefined)?.filter((n) => new Date(n.timestamp) >= lastWorkday)} />
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
          <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/40">Today</span>
          <div className="flex-1 h-px bg-border" />
        </div>
        {planInProgress.length === 0 && plan.length === 0 ? (
          <p className="text-[15px] text-muted-foreground/30">No tasks planned.</p>
        ) : (
          <div className="space-y-2.5">
            {planInProgress.map((t) => {
              const subs = getSubtasks(t.metadata)
              const pendingSubs = subs.filter((s) => !subtaskDone(s))
              return (
                <TaskCard key={t.id} task={t} variant="plan" lastWorkday={lastWorkday}>
                  {pendingSubs.map((s) => {
                    const st = subtaskStatus(s)
                    return <SubtaskRow key={s.id} title={s.title} status={st} done={false} priority={(s.priority as EntityPriority | undefined) ?? t.priority} notes={(s.notes as TaskNote[] | undefined)?.filter((n) => new Date(n.timestamp) >= lastWorkday)} />
                  })}
                </TaskCard>
              )
            })}
            {plan.map((t) => (
              <TaskCard key={t.id} task={t} variant="plan" lastWorkday={lastWorkday} />
            ))}
          </div>
        )}
      </section>

      {/* Blockers — full width */}
      {blocked.length > 0 && (
        <section className="col-span-2">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-destructive/50">Blockers</span>
            <div className="flex-1 h-px bg-destructive/20" />
          </div>
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 space-y-1.5">
            {blocked.map((t) => (
              <div key={t.id} className="flex items-center gap-2.5">
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
// Component
// ---------------------------------------------------------------------------

export function StandupReport({ open, onOpenChange, tasks, todayPriorityIds = [] }: StandupReportProps) {
  const [ws, setWs] = useState<StandupWorkspace>('all')
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
    const planInProgress = planAll.filter(
      (t) => getSubtasks(t.metadata).some((s) => !subtaskDone(s)),
    )
    const planInProgressIds = new Set(planInProgress.map((t) => t.id))
    const planTopLevel = planAll.filter((t) => !planInProgressIds.has(t.id))
    const blockedTasks = filtered.filter((t) => t.status === 'in-progress')

    return { done: doneTasks, inProgressWithDoneSubs: inProgressWithCompletedSubs, plan: planTopLevel, planInProgress, blocked: blockedTasks }
  }, [filtered, lastWorkday, todayPriorityIds])

  const markdown = useMemo(
    () => buildMarkdown(done, inProgressWithDoneSubs, planInProgress, plan, blocked, lastWorkday, sinceLabel),
    [done, inProgressWithDoneSubs, planInProgress, plan, blocked, lastWorkday, sinceLabel],
  )

  const copyToClipboard = () => {
    navigator.clipboard.writeText(markdown)
    notify({ title: 'Copied to clipboard', type: 'success' })
  }

  const today = new Date()
  const dateLine = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] p-0 gap-0 overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-start justify-between">
          <DialogHeader>
            <DialogTitle className="text-2xl font-semibold tracking-tight">{dateLine}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground/50">
              Morning brief
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-3">
            {/* Priority legend */}
            <div className="hidden sm:flex items-center gap-2 text-[10px] text-muted-foreground/40 mr-2">
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
          </div>
        </div>

        {/* Content */}
        <div className="px-6 pb-6 overflow-y-auto">
          <StandupRender
            done={done}
            inProgressWithDoneSubs={inProgressWithDoneSubs}
            planInProgress={planInProgress}
            plan={plan}
            blocked={blocked}
            lastWorkday={lastWorkday}
            sinceLabel={sinceLabel}
          />
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t">
          <Button onClick={copyToClipboard} variant="outline" size="sm" className="gap-2">
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy Markdown
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
