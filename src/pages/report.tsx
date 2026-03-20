import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router'
import {
  ClipboardCopy,
  Maximize2,
  CalendarDays,
  CalendarRange,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEntities, useTrackers } from '@/core/hooks'
import { notify } from '@/lib/notify'
import { getSubtasks, subtaskDone } from './tasks/task-helpers'
import { getTodayPriorities } from './today/today-helpers'
import { getWeekStart } from './review/review-helpers'
import { CaptureBar } from './today/capture-bar'
import type { EntityPriority } from '@/core/types'

// ─── Shared helpers ───

function getLastWorkday(): Date {
  const now = new Date()
  const day = now.getDay()
  const daysBack = day === 1 ? 3 : day === 0 ? 2 : 1
  const d = new Date(now)
  d.setDate(d.getDate() - daysBack)
  d.setHours(0, 0, 0, 0)
  return d
}

const pChar = (p: EntityPriority) => p === 'urgent' ? '⬆⬆' : p === 'high' ? '⬆' : p === 'medium' ? '—' : '⬇'

type ReportTab = 'daily' | 'weekly'

export function ReportPage() {
  const [tab, setTab] = useState<ReportTab>('daily')
  const navigate = useNavigate()

  return (
    <div className="max-w-3xl space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Report</h1>
          <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
            <button
              onClick={() => setTab('daily')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                tab === 'daily' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Daily
            </button>
            <button
              onClick={() => setTab('weekly')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                tab === 'weekly' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <CalendarRange className="h-3.5 w-3.5" />
              Weekly
            </button>
          </div>
        </div>
        {tab === 'daily' && (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate('/briefing')}>
            <Maximize2 className="h-3.5 w-3.5" />
            Present
          </Button>
        )}
      </div>

      {tab === 'daily' ? <DailyReport /> : <WeeklyReport />}
    </div>
  )
}

// ─── Daily Report (compact standup view) ───

function DailyReport() {
  const { items: allEntities } = useEntities()
  const tasks = useMemo(() => allEntities.filter((e) => e.type === 'task' || e.type === 'chore'), [allEntities])

  const todayPriorityIds = useMemo(() => getTodayPriorities(), [])
  const lastWorkday = useMemo(() => getLastWorkday(), [])
  const sinceLabel = useMemo(() => lastWorkday.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), [lastWorkday])

  const { done, inProgressWithDoneSubs, plan, planInProgress, blocked } = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]
    const doneTasks = tasks.filter((t) => t.status === 'done' && t.updatedAt && new Date(t.updatedAt) >= lastWorkday)
    const inProg = tasks.filter((t) => t.status === 'in-progress' && getSubtasks(t.metadata).some((s) => subtaskDone(s)))
    const prioritySet = new Set(todayPriorityIds)
    const planAll = tasks.filter((t) =>
      t.status !== 'done' && t.status !== 'archived' &&
      (prioritySet.has(t.id) || t.dueDate === today || t.priority === 'urgent' || t.priority === 'high'),
    )
    const planInProg = planAll.filter((t) => getSubtasks(t.metadata).some((s) => !subtaskDone(s)))
    const planInProgressIds = new Set(planInProg.map((t) => t.id))
    const planTop = planAll.filter((t) => !planInProgressIds.has(t.id))
    const blockedTasks = tasks.filter((t) => t.status === 'in-progress')
    return { done: doneTasks, inProgressWithDoneSubs: inProg, plan: planTop, planInProgress: planInProg, blocked: blockedTasks }
  }, [tasks, lastWorkday, todayPriorityIds])

  const markdown = useMemo(() => {
    const today = new Date()
    const dateLine = today.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
    const lines: string[] = [`# Daily Report — ${dateLine}`, '']

    lines.push(`## Since ${sinceLabel}`, '')
    const latest = [...done, ...inProgressWithDoneSubs]
    if (!latest.length) { lines.push('No updates.') } else {
      latest.forEach((t, i) => {
        const subs = getSubtasks(t.metadata)
        const ds = subs.filter(subtaskDone)
        lines.push(t.status === 'done'
          ? `${i + 1}. ${pChar(t.priority)} ~~${t.title}~~`
          : `${i + 1}. ${pChar(t.priority)} **${t.title}** (${ds.length}/${subs.length})`)
      })
    }

    lines.push('', '## Today', '')
    const todayAll = [...planInProgress, ...plan]
    if (!todayAll.length) { lines.push('No tasks planned.') } else {
      todayAll.forEach((t, i) => lines.push(`${i + 1}. ${pChar(t.priority)} ${t.title}`))
    }

    if (blocked.length) {
      lines.push('', '## Blockers', '')
      blocked.forEach((t, i) => lines.push(`${i + 1}. ${pChar(t.priority)} ${t.title}`))
    }
    return lines.join('\n')
  }, [done, inProgressWithDoneSubs, planInProgress, plan, blocked, sinceLabel])

  const copy = () => { navigator.clipboard.writeText(markdown); notify({ title: 'Copied', type: 'success' }) }

  const hasLatest = done.length > 0 || inProgressWithDoneSubs.length > 0

  return (
    <div className="space-y-5">
      <CaptureBar />

      <div className="grid grid-cols-2 gap-8">
        {/* Since */}
        <section>
          <SH label={`Since ${sinceLabel}`} />
          {!hasLatest ? <Empty /> : (
            <ol className="space-y-1.5 list-decimal list-inside text-sm">
              {[...done, ...inProgressWithDoneSubs].map((t) => {
                const subs = getSubtasks(t.metadata)
                const ds = subs.filter(subtaskDone)
                return (
                  <li key={t.id} className={t.status === 'done' ? 'line-through text-muted-foreground/50' : ''}>
                    <span className="text-[11px] text-muted-foreground/40 mr-1">{pChar(t.priority)}</span>
                    {t.title}
                    {ds.length > 0 && t.status !== 'done' && <span className="text-muted-foreground/40 text-xs ml-1">({ds.length}/{subs.length})</span>}
                  </li>
                )
              })}
            </ol>
          )}
        </section>

        {/* Today */}
        <section>
          <SH label="Today" />
          {planInProgress.length === 0 && plan.length === 0 ? <Empty /> : (
            <ol className="space-y-1.5 list-decimal list-inside text-sm">
              {[...planInProgress, ...plan].map((t) => (
                <li key={t.id}>
                  <span className="text-[11px] text-muted-foreground/40 mr-1">{pChar(t.priority)}</span>
                  {t.title}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {blocked.length > 0 && (
        <section>
          <SH label="Blockers" variant="destructive" />
          <ol className="space-y-1 list-decimal list-inside text-sm text-destructive/80">
            {blocked.map((t) => (
              <li key={t.id}>{t.title}</li>
            ))}
          </ol>
        </section>
      )}

      <div className="pt-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={copy}>
          <ClipboardCopy className="h-3.5 w-3.5" />
          Copy Markdown
        </Button>
      </div>
    </div>
  )
}

// ─── Weekly Report ───

function WeeklyReport() {
  const { items: allEntities } = useEntities()
  const { items: allTrackers } = useTrackers()
  const weekStart = getWeekStart()

  const completed = useMemo(
    () => allEntities.filter((e) => (e.type === 'task' || e.type === 'goal') && e.status === 'done' && e.updatedAt.split('T')[0] >= weekStart),
    [allEntities, weekStart],
  )

  const goalsInProgress = useMemo(
    () => allEntities.filter((e) => e.type === 'goal' && (e.status === 'in-progress' || e.status === 'todo')),
    [allEntities],
  )

  const habitSummaries = useMemo(() => {
    const habits = allEntities.filter((e) => e.type === 'habit' && e.status === 'todo')
    return habits.map((habit) => {
      const checkIns = allTrackers.filter((t) => t.entityId === habit.id && t.timestamp.split('T')[0] >= weekStart).length
      const streak = typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
      return { habit, checkIns, streak }
    })
  }, [allEntities, allTrackers, weekStart])

  const inboxCount = allEntities.filter((e) => e.metadata.isInbox === true && e.status === 'todo').length

  const markdown = useMemo(() => {
    const lines: string[] = [`# Weekly Report — Week of ${weekStart}`, '']

    lines.push(`## Completed (${completed.length})`, '')
    if (!completed.length) { lines.push('No completions this week.') } else {
      completed.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`))
    }

    lines.push('', `## Goals (${goalsInProgress.length} active)`, '')
    goalsInProgress.forEach((g, i) => {
      const subs = getSubtasks(g.metadata)
      const ds = subs.filter(subtaskDone)
      const pct = subs.length > 0 ? Math.round((ds.length / subs.length) * 100) : 0
      lines.push(`${i + 1}. ${g.title}${subs.length > 0 ? ` (${pct}%)` : ''}`)
    })

    lines.push('', '## Habits', '')
    habitSummaries.forEach((h) => {
      lines.push(`- ${h.habit.title}: ${h.checkIns} check-ins, streak ${h.streak}`)
    })

    if (inboxCount > 0) {
      lines.push('', `## Inbox: ${inboxCount} items pending`)
    }

    return lines.join('\n')
  }, [completed, goalsInProgress, habitSummaries, inboxCount, weekStart])

  const copy = () => { navigator.clipboard.writeText(markdown); notify({ title: 'Copied', type: 'success' }) }

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Completed" value={completed.length} />
        <StatCard label="Active Goals" value={goalsInProgress.length} />
        <StatCard label="Habit Avg" value={habitSummaries.length > 0 ? `${Math.round(habitSummaries.reduce((s, h) => s + h.checkIns, 0) / habitSummaries.length)}` : '0'} />
      </div>

      {/* Completed */}
      <section>
        <SH label={`Completed (${completed.length})`} />
        {!completed.length ? <Empty text="Nothing completed this week." /> : (
          <ol className="space-y-1.5 list-decimal list-inside text-sm">
            {completed.map((t) => (
              <li key={t.id} className="text-muted-foreground/70 line-through">{t.title}</li>
            ))}
          </ol>
        )}
      </section>

      {/* Goals progress */}
      <section>
        <SH label={`Goals (${goalsInProgress.length} active)`} />
        {!goalsInProgress.length ? <Empty text="No active goals." /> : (
          <div className="space-y-2">
            {goalsInProgress.map((g) => {
              const subs = getSubtasks(g.metadata)
              const ds = subs.filter(subtaskDone)
              const pct = subs.length > 0 ? Math.round((ds.length / subs.length) * 100) : 0
              return (
                <div key={g.id} className="flex items-center gap-3">
                  <span className="text-sm flex-1">{g.title}</span>
                  {subs.length > 0 && (
                    <>
                      <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-muted-foreground/50 w-8 text-right">{pct}%</span>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Habits */}
      <section>
        <SH label="Habits" />
        {!habitSummaries.length ? <Empty text="No habits tracked." /> : (
          <div className="space-y-1.5">
            {habitSummaries.map(({ habit, checkIns, streak }) => (
              <div key={habit.id} className="flex items-center gap-3 text-sm">
                <span className="flex-1">{habit.title}</span>
                <span className="text-xs text-muted-foreground/50">{checkIns} this week</span>
                {streak > 0 && <span className="text-xs text-amber-500">🔥 {streak}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Inbox status */}
      {inboxCount > 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <p className="text-sm text-amber-600 dark:text-amber-400">
            📥 {inboxCount} items in inbox — process before closing the week
          </p>
        </div>
      )}

      <div className="pt-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={copy}>
          <ClipboardCopy className="h-3.5 w-3.5" />
          Copy Markdown
        </Button>
      </div>
    </div>
  )
}

// ─── Shared UI ───

function SH({ label, variant }: { label: string; variant?: 'destructive' }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className={`text-[11px] font-semibold uppercase tracking-widest ${variant === 'destructive' ? 'text-destructive/50' : 'text-muted-foreground/40'}`}>
        {label}
      </span>
      <div className={`flex-1 h-px ${variant === 'destructive' ? 'bg-destructive/20' : 'bg-border'}`} />
    </div>
  )
}

function Empty({ text = 'No updates.' }: { text?: string }) {
  return <p className="text-sm text-muted-foreground/30">{text}</p>
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground/50">{label}</p>
      <p className="text-lg font-semibold mt-0.5">{value}</p>
    </div>
  )
}
