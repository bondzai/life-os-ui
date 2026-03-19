import { useMemo, useState, useCallback } from 'react'
import {
  Crown,
  Timer,
  Flame,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  Plus,
  X,
  Clock,
  Zap,
  Target,
  Briefcase,
  User,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useEntities, useTrackers } from '@/core/hooks'
import { formatMinutes as fmtMin } from '@/lib/focus-stats'
import type { Tracker } from '@/core/types'

/* ─── Types ─── */

interface ParsedNote {
  sessionId?: string
  task: string
  completed: string[]
  progress?: string
  preset?: string
  workMinutes?: number
  pomodoroIndex?: number
  workspace?: string | null
}

interface FocusEntry {
  tracker: Tracker
  title: string
  note: ParsedNote | null
  time: string
}

interface SessionBlock {
  sessionId: string
  entries: FocusEntry[]
  totalMinutes: number
  startTime: string
  endTime: string
  date: string
  dateLabel: string
  taskCount: number
  completedCount: number
  // Derived stats
  preset: string | null
  workMinutes: number | null
  pomodoroCount: number
  workspaces: { work: number; personal: number }
  taskBreakdown: { title: string; minutes: number; completed: number }[]
  avgPomodoroMin: number
}

/* ─── Helpers ─── */

function parseNote(raw?: string | null): ParsedNote | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw)
    if (typeof p === 'object' && p.task) return p as ParsedNote
  } catch { /* ignore */ }
  return null
}

function formatDate(dateStr: string): string {
  const today = new Date().toISOString().split('T')[0]
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
  if (dateStr === today) return 'Today'
  if (dateStr === yesterday) return 'Yesterday'
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function presetLabel(preset: string | null): string {
  if (preset === 'classic') return 'Classic 25m'
  if (preset === 'deep') return 'Deep 50m'
  if (preset === 'sprint') return 'Sprint 90m'
  return preset ?? 'Custom'
}

function timeOfDay(time: string): string {
  const h = parseInt(time.split(':')[0], 10)
  if (h < 12) return 'Morning'
  if (h < 17) return 'Afternoon'
  return 'Evening'
}

/* ─── Entry Editor ─── */

function EntryEditor({ entry, onSave, onCancel }: {
  entry: FocusEntry
  onSave: (id: string, note: string) => void
  onCancel: () => void
}) {
  const parsed = entry.note
  const [completed, setCompleted] = useState<string[]>(parsed?.completed ?? [])
  const [newItem, setNewItem] = useState('')

  const handleSave = () => {
    const updated: ParsedNote = {
      ...(parsed ?? { task: entry.title, completed: [] }),
      completed: completed.filter((c) => c.trim()),
    }
    onSave(entry.tracker.id, JSON.stringify(updated))
  }

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground tabular-nums">{entry.time}</span>
        <span className="text-sm font-medium flex-1 truncate">{entry.title}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{entry.tracker.value}m</span>
      </div>

      <div className="space-y-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">What was done</span>
        {completed.map((item, i) => (
          <div key={i} className="flex items-center gap-2 group">
            <CheckCircle2 className="h-3 w-3 text-green-500/60 shrink-0" />
            <input
              className="flex-1 text-xs bg-transparent border-0 border-b border-transparent focus:border-border px-0 py-0.5 focus:outline-none"
              value={item}
              onChange={(e) => {
                const next = [...completed]
                next[i] = e.target.value
                setCompleted(next)
              }}
            />
            <button onClick={() => setCompleted(completed.filter((_, j) => j !== i))} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity">
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Plus className="h-3 w-3 text-muted-foreground/40 shrink-0" />
          <input
            className="flex-1 text-xs bg-transparent border-0 border-b border-dashed border-border/50 px-0 py-1 focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/30"
            placeholder="Add completed item..."
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newItem.trim()) {
                setCompleted([...completed, newItem.trim()])
                setNewItem('')
              }
            }}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} className="h-7 text-xs px-3">Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-7 text-xs px-3">Cancel</Button>
      </div>
    </div>
  )
}

/* ─── Session Card ─── */

function SessionCard({ block, onUpdate, onDelete }: {
  block: SessionBlock
  onUpdate: (id: string, note: string) => void
  onDelete: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const tod = timeOfDay(block.startTime)

  return (
    <Card className="overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-4 hover:bg-muted/30 transition-colors"
      >
        {/* Row 1: Date, time range, total */}
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground/50 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
          )}
          <Crown className="h-4 w-4 text-amber-500/70 shrink-0" />
          <span className="text-sm font-semibold flex-1">{block.dateLabel}</span>
          <span className="text-[10px] text-muted-foreground tabular-nums">{block.startTime} – {block.endTime}</span>
          <span className="text-sm font-bold tabular-nums text-amber-500 ml-2">{fmtMin(block.totalMinutes)}</span>
        </div>

        {/* Row 2: Stat pills */}
        <div className="flex items-center gap-2 mt-2.5 ml-9 flex-wrap">
          {/* Preset */}
          {block.preset && (
            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400/80 font-medium">
              <Zap className="h-2.5 w-2.5" />
              {presetLabel(block.preset)}
            </span>
          )}

          {/* Time of day */}
          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400/70 font-medium">
            <Clock className="h-2.5 w-2.5" />
            {tod}
          </span>

          {/* Pomodoro count */}
          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400/70 font-medium">
            <Flame className="h-2.5 w-2.5" />
            {block.pomodoroCount} pomodoro{block.pomodoroCount !== 1 ? 's' : ''}
          </span>

          {/* Tasks */}
          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400/70 font-medium">
            <Target className="h-2.5 w-2.5" />
            {block.taskCount} task{block.taskCount !== 1 ? 's' : ''}
          </span>

          {/* Completed items */}
          {block.completedCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400/70 font-medium">
              <CheckCircle2 className="h-2.5 w-2.5" />
              {block.completedCount} done
            </span>
          )}

          {/* Workspace split */}
          {(block.workspaces.work > 0 || block.workspaces.personal > 0) && (
            <>
              {block.workspaces.work > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400/70 font-medium">
                  <Briefcase className="h-2.5 w-2.5" />
                  {fmtMin(block.workspaces.work)}
                </span>
              )}
              {block.workspaces.personal > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400/70 font-medium">
                  <User className="h-2.5 w-2.5" />
                  {fmtMin(block.workspaces.personal)}
                </span>
              )}
            </>
          )}
        </div>

        {/* Row 3: Task breakdown bars */}
        {block.taskBreakdown.length > 0 && (
          <div className="mt-3 ml-9 space-y-1.5">
            {block.taskBreakdown.map((tb) => {
              const pct = block.totalMinutes > 0 ? (tb.minutes / block.totalMinutes) * 100 : 0
              return (
                <div key={tb.title} className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground truncate w-32 shrink-0">{tb.title}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-muted/30 overflow-hidden">
                    <div className="h-full rounded-full bg-amber-500/50" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[10px] text-muted-foreground/60 tabular-nums w-10 text-right shrink-0">{fmtMin(tb.minutes)}</span>
                  {tb.completed > 0 && (
                    <span className="text-[9px] text-green-500/50 tabular-nums shrink-0">+{tb.completed}</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </button>

      {/* Expanded: individual pomodoro entries */}
      {expanded && (
        <div className="px-4 pb-4 space-y-1.5 border-t border-border/30 pt-3">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Pomodoro Log</span>
            <span className="text-[9px] text-muted-foreground/30">avg {block.avgPomodoroMin}m per pomodoro</span>
          </div>

          {block.entries.map((entry, idx) => {
            if (editingId === entry.tracker.id) {
              return (
                <EntryEditor
                  key={entry.tracker.id}
                  entry={entry}
                  onSave={(id, note) => { onUpdate(id, note); setEditingId(null) }}
                  onCancel={() => setEditingId(null)}
                />
              )
            }

            return (
              <div key={entry.tracker.id} className="group rounded-lg hover:bg-muted/20 px-3 py-2 transition-colors">
                <div className="flex items-center gap-2">
                  {/* Pomodoro number */}
                  <span className="text-[9px] font-medium text-muted-foreground/40 tabular-nums w-4 shrink-0">
                    #{entry.note?.pomodoroIndex ?? idx + 1}
                  </span>
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500/50 shrink-0" />
                  <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">{entry.time}</span>
                  <span className="text-sm truncate flex-1">{entry.title}</span>

                  {/* Workspace badge */}
                  {entry.note?.workspace && (
                    <span className={`text-[8px] px-1.5 py-0.5 rounded-full shrink-0 ${
                      entry.note.workspace === 'work'
                        ? 'bg-blue-500/10 text-blue-400/60'
                        : 'bg-emerald-500/10 text-emerald-400/60'
                    }`}>
                      {entry.note.workspace === 'work' ? 'W' : 'P'}
                    </span>
                  )}

                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">{entry.tracker.value}m</span>

                  {entry.note?.progress && (
                    <span className="text-[9px] text-muted-foreground/40 tabular-nums shrink-0">{entry.note.progress}</span>
                  )}

                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingId(entry.tracker.id) }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
                    title="Edit"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(entry.tracker.id) }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>

                {entry.note?.completed && entry.note.completed.length > 0 && (
                  <div className="mt-1 ml-10 space-y-0.5">
                    {entry.note.completed.map((item, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <CheckCircle2 className="h-2.5 w-2.5 text-green-500/60 shrink-0" />
                        <span className="text-[11px] text-muted-foreground">{item}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {/* Session meta */}
          <div className="flex items-center gap-3 pt-2 border-t border-border/20">
            <span className="text-[9px] text-muted-foreground/25 font-mono">
              {block.sessionId.slice(0, 8)}
            </span>
            {block.preset && (
              <span className="text-[9px] text-muted-foreground/25">
                {presetLabel(block.preset)}
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

/* ─── Standalone Entry (no sessionId) ─── */

function StandaloneEntry({ entry, onUpdate, onDelete }: {
  entry: FocusEntry
  onUpdate: (id: string, note: string) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <Card className="p-3">
        <EntryEditor
          entry={entry}
          onSave={(id, note) => { onUpdate(id, note); setEditing(false) }}
          onCancel={() => setEditing(false)}
        />
      </Card>
    )
  }

  return (
    <Card className="group hover:bg-muted/10 transition-colors">
      <div className="flex items-center gap-3 p-3">
        <Timer className="h-4 w-4 text-muted-foreground/40 shrink-0" />
        <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">{entry.time}</span>
        <span className="text-sm truncate flex-1">{entry.title}</span>
        {entry.note?.workspace && (
          <span className={`text-[8px] px-1.5 py-0.5 rounded-full shrink-0 ${
            entry.note.workspace === 'work'
              ? 'bg-blue-500/10 text-blue-400/60'
              : 'bg-emerald-500/10 text-emerald-400/60'
          }`}>
            {entry.note.workspace === 'work' ? 'Work' : 'Personal'}
          </span>
        )}
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">{entry.tracker.value}m</span>
        {entry.note?.progress && (
          <span className="text-[9px] text-muted-foreground/50 tabular-nums shrink-0">{entry.note.progress}</span>
        )}
        <button onClick={() => setEditing(true)} className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary">
          <Pencil className="h-3 w-3" />
        </button>
        <button onClick={() => onDelete(entry.tracker.id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {entry.note?.completed && entry.note.completed.length > 0 && (
        <div className="px-3 pb-3 ml-9 space-y-0.5">
          {entry.note.completed.map((item, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <CheckCircle2 className="h-2.5 w-2.5 text-green-500/60 shrink-0" />
              <span className="text-[11px] text-muted-foreground">{item}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/* ─── Main Page ─── */

export function SessionsPage() {
  const { items: allEntities } = useEntities()
  const { items: allTrackers, update: updateTracker, remove: removeTracker } = useTrackers()

  const entityTitles = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of allEntities) m.set(e.id, e.title)
    return m
  }, [allEntities])

  const handleUpdate = useCallback((id: string, note: string) => {
    updateTracker.mutate({ id, updates: { note } })
  }, [updateTracker])

  const handleDelete = useCallback((id: string) => {
    removeTracker.mutate(id)
  }, [removeTracker])

  // Build all focus entries
  const allEntries = useMemo(() => {
    return allTrackers
      .filter((t) => t.unit === 'focus-min')
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map((t): FocusEntry => {
        const note = parseNote(t.note)
        return {
          tracker: t,
          title: entityTitles.get(t.entityId) || 'Unknown',
          note,
          time: new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }
      })
  }, [allTrackers, entityTitles])

  // Group into session blocks + standalone
  const { sessionBlocks, standaloneEntries } = useMemo(() => {
    const sessionMap = new Map<string, FocusEntry[]>()
    const standalone: FocusEntry[] = []

    for (const entry of allEntries) {
      const sid = entry.note?.sessionId
      if (sid) {
        const list = sessionMap.get(sid) ?? []
        list.push(entry)
        sessionMap.set(sid, list)
      } else {
        standalone.push(entry)
      }
    }

    const blocks: SessionBlock[] = []
    for (const [sessionId, entries] of sessionMap) {
      // Sort entries chronologically within session
      entries.sort((a, b) => a.tracker.timestamp.localeCompare(b.tracker.timestamp))
      const date = entries[0].tracker.timestamp.split('T')[0]

      // Compute workspace minutes
      const workspaces = { work: 0, personal: 0 }
      for (const e of entries) {
        const ws = e.note?.workspace
        if (ws === 'work') workspaces.work += e.tracker.value
        else if (ws === 'personal') workspaces.personal += e.tracker.value
      }

      // Task breakdown
      const taskMap = new Map<string, { minutes: number; completed: number }>()
      for (const e of entries) {
        const key = e.title
        const existing = taskMap.get(key) ?? { minutes: 0, completed: 0 }
        existing.minutes += e.tracker.value
        existing.completed += e.note?.completed?.length ?? 0
        taskMap.set(key, existing)
      }
      const taskBreakdown = Array.from(taskMap.entries())
        .map(([title, data]) => ({ title, ...data }))
        .sort((a, b) => b.minutes - a.minutes)

      const totalMinutes = entries.reduce((sum, e) => sum + e.tracker.value, 0)
      const completedCount = entries.reduce((sum, e) => sum + (e.note?.completed?.length ?? 0), 0)

      // Get preset from first entry that has one
      const presetEntry = entries.find((e) => e.note?.preset)
      const preset = presetEntry?.note?.preset ?? null

      blocks.push({
        sessionId,
        entries,
        totalMinutes,
        startTime: entries[0].time,
        endTime: entries[entries.length - 1].time,
        date,
        dateLabel: formatDate(date),
        taskCount: taskMap.size,
        completedCount,
        preset,
        workMinutes: presetEntry?.note?.workMinutes ?? null,
        pomodoroCount: entries.length,
        workspaces,
        taskBreakdown,
        avgPomodoroMin: entries.length > 0 ? Math.round(totalMinutes / entries.length) : 0,
      })
    }

    // Sort blocks by most recent first
    blocks.sort((a, b) => {
      const dateCmp = b.date.localeCompare(a.date)
      if (dateCmp !== 0) return dateCmp
      // Within same day, sort by start time desc
      return b.entries[0].tracker.timestamp.localeCompare(a.entries[0].tracker.timestamp)
    })

    return { sessionBlocks: blocks, standaloneEntries: standalone }
  }, [allEntries])

  // Stats
  const stats = useMemo(() => {
    const totalMinutes = allEntries.reduce((sum, e) => sum + e.tracker.value, 0)
    const totalCompleted = allEntries.reduce((sum, e) => sum + (e.note?.completed?.length ?? 0), 0)
    const avgSessionMin = sessionBlocks.length > 0
      ? Math.round(sessionBlocks.reduce((sum, b) => sum + b.totalMinutes, 0) / sessionBlocks.length)
      : 0

    // Work vs personal
    let workMin = 0
    let personalMin = 0
    for (const e of allEntries) {
      const ws = e.note?.workspace
      if (ws === 'work') workMin += e.tracker.value
      else if (ws === 'personal') personalMin += e.tracker.value
    }

    return {
      totalSessions: sessionBlocks.length,
      totalPomodoros: allEntries.length,
      totalMinutes,
      totalCompleted,
      avgSessionMin,
      workMin,
      personalMin,
    }
  }, [allEntries, sessionBlocks])

  return (
    <div className="h-[calc(100vh-5rem)] flex flex-col overflow-y-auto scrollbar-thin">
      <header className="shrink-0 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Crown className="h-6 w-6 text-amber-500/70" />
          Emperor Time
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">Review, edit, and analyze your focus sessions</p>
      </header>

      <div className="space-y-6 pb-8">
        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          {[
            { label: 'Sessions', value: `${stats.totalSessions}`, icon: Crown, color: 'text-amber-500/60' },
            { label: 'Pomodoros', value: `${stats.totalPomodoros}`, icon: Flame, color: 'text-orange-500/60' },
            { label: 'Total Focus', value: fmtMin(stats.totalMinutes), icon: Timer, color: 'text-muted-foreground/40' },
            { label: 'Avg Session', value: fmtMin(stats.avgSessionMin), icon: Clock, color: 'text-sky-500/60' },
            { label: 'Items Done', value: `${stats.totalCompleted}`, icon: CheckCircle2, color: 'text-green-500/60' },
            { label: 'Work', value: fmtMin(stats.workMin), icon: Briefcase, color: 'text-blue-500/60' },
            { label: 'Personal', value: fmtMin(stats.personalMin), icon: User, color: 'text-emerald-500/60' },
          ].map((s) => (
            <div key={s.label} className="bg-muted/20 rounded-lg p-2.5 text-center">
              <s.icon className={`h-3.5 w-3.5 mx-auto mb-1 ${s.color}`} />
              <p className="text-sm font-semibold tabular-nums">{s.value}</p>
              <p className="text-[9px] text-muted-foreground/50 uppercase tracking-wider">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Session blocks */}
        {sessionBlocks.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              <Crown className="h-3 w-3 inline mr-1.5 -mt-px text-amber-500" />
              Emperor Time Sessions
              <span className="text-muted-foreground/40 ml-2 normal-case font-normal">{sessionBlocks.length} total</span>
            </h2>
            {sessionBlocks.map((block) => (
              <SessionCard
                key={block.sessionId}
                block={block}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        {/* Standalone entries */}
        {standaloneEntries.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              <Timer className="h-3 w-3 inline mr-1.5 -mt-px" />
              Individual Sessions
            </h2>
            {standaloneEntries.map((entry) => (
              <StandaloneEntry
                key={entry.tracker.id}
                entry={entry}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        {allEntries.length === 0 && (
          <div className="text-center py-16 space-y-3">
            <Crown className="h-10 w-10 mx-auto text-amber-500/20" />
            <p className="text-sm text-muted-foreground">No focus sessions yet</p>
            <p className="text-xs text-muted-foreground/50">Complete a pomodoro in Emperor Time to see your sessions here.</p>
          </div>
        )}
      </div>
    </div>
  )
}
