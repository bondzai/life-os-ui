import { useState, useMemo } from 'react'
import { ClipboardCopy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { notify } from '@/lib/notify'
import { getSubtasks, subtaskDone, subtaskStatus } from './task-helpers'
import type { Entity } from '@/core/types'

type StandupWorkspace = 'all' | 'work' | 'personal'

interface StandupReportProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: Entity[]
  todayPriorityIds?: string[]
}

function getLastWorkday(): Date {
  const now = new Date()
  const day = now.getDay() // 0=Sun, 1=Mon, ...
  const daysBack = day === 1 ? 3 : day === 0 ? 2 : 1
  const d = new Date(now)
  d.setDate(d.getDate() - daysBack)
  d.setHours(0, 0, 0, 0)
  return d
}

function formatWorkdayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

export function StandupReport({ open, onOpenChange, tasks, todayPriorityIds = [] }: StandupReportProps) {
  const [ws, setWs] = useState<StandupWorkspace>('all')
  const lastWorkday = useMemo(() => getLastWorkday(), [])
  const lastWorkdayLabel = useMemo(() => formatWorkdayLabel(lastWorkday), [lastWorkday])

  const filtered = useMemo(() => {
    if (ws === 'all') return tasks
    return tasks.filter((t) => t.metadata.workspace === ws)
  }, [tasks, ws])

  const { done, inProgressWithDoneSubs, plan, planInProgress, blocked } = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]

    const doneTasks = filtered.filter(
      (t) =>
        t.status === 'done' &&
        t.updatedAt &&
        new Date(t.updatedAt) >= lastWorkday,
    )

    // In-progress tasks that have completed subtasks (partial progress worth reporting)
    const inProgressWithCompletedSubs = filtered.filter(
      (t) =>
        t.status === 'in-progress' &&
        getSubtasks(t.metadata).some((s) => subtaskDone(s)),
    )

    // Plan: today priorities + due/high-priority tasks + in-progress with remaining subtasks
    const prioritySet = new Set(todayPriorityIds)
    const planAll = filtered.filter(
      (t) =>
        t.status !== 'done' &&
        t.status !== 'archived' &&
        (prioritySet.has(t.id) || t.dueDate === today || t.priority === 'urgent' || t.priority === 'high'),
    )
    // Split into tasks with pending subtasks vs simple tasks
    const planInProgress = planAll.filter(
      (t) => getSubtasks(t.metadata).some((s) => !subtaskDone(s)),
    )
    const planInProgressIds = new Set(planInProgress.map((t) => t.id))
    const planTopLevel = planAll.filter((t) => !planInProgressIds.has(t.id))

    const blockedTasks = filtered.filter((t) => t.status === 'in-progress')

    return { done: doneTasks, inProgressWithDoneSubs: inProgressWithCompletedSubs, plan: planTopLevel, planInProgress, blocked: blockedTasks }
  }, [filtered, lastWorkday])

  const wsLabel = ws === 'all' ? '' : ws === 'work' ? ' (Work)' : ' (Personal)'

  const copyToClipboard = () => {
    const formatTaskWithSubs = (t: Entity) => {
      const subs = getSubtasks(t.metadata)
      const doneSubs = subs.filter((s) => subtaskDone(s))
      const lines = [`• ${t.title}`]
      if (doneSubs.length > 0) {
        doneSubs.forEach((s) => lines.push(`  ✓ ${s.title}`))
      }
      return lines.join('\n')
    }

    const sections = [
      `✅ Done${wsLabel} (since ${lastWorkdayLabel}):`,
      done.length > 0 ? done.map(formatTaskWithSubs).join('\n') : '• (none)',
    ]

    if (inProgressWithDoneSubs.length > 0) {
      sections.push('', `🔄 In Progress${wsLabel}:`)
      sections.push(inProgressWithDoneSubs.map(formatTaskWithSubs).join('\n'))
    }

    const planLines: string[] = []
    for (const t of planInProgress) {
      const subs = getSubtasks(t.metadata)
      const pendingSubs = subs.filter((s) => !subtaskDone(s))
      const doneSubs = subs.filter((s) => subtaskDone(s))
      planLines.push(`• ${t.title} (${doneSubs.length}/${subs.length})`)
      pendingSubs.forEach((s) => {
        const st = subtaskStatus(s)
        planLines.push(`  ${st === 'in-progress' ? '→' : '○'} ${s.title}`)
      })
    }
    for (const t of plan) {
      planLines.push(`• ${t.title}`)
    }

    sections.push(
      '',
      `📌 Today's Plan${wsLabel}:`,
      planLines.length > 0 ? planLines.join('\n') : '• (none)',
      '',
      `🚧 Blocked${wsLabel}:`,
      blocked.length > 0 ? blocked.map((t) => `• ${t.title}`).join('\n') : '• (none)',
    )

    navigator.clipboard.writeText(sections.join('\n'))
    notify({ title: 'Copied to clipboard', type: 'success' })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[450px]">
        <SheetHeader>
          <SheetTitle>Standup Summary</SheetTitle>
          <SheetDescription>
            Summary since {lastWorkdayLabel}
          </SheetDescription>
        </SheetHeader>

        {/* Workspace filter */}
        <div className="flex bg-muted rounded-lg p-0.5 gap-0.5 mt-4">
          {(['all', 'work', 'personal'] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWs(w)}
              className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                ws === w
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {w === 'all' ? 'All' : w === 'work' ? '🏢 Work' : '🏠 Personal'}
            </button>
          ))}
        </div>

        <div className="mt-5 space-y-5">
          {/* Done */}
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-2">
              ✅ Done
              <span className="text-muted-foreground font-normal text-xs">
                since {lastWorkdayLabel}
              </span>
            </h3>
            {done.length === 0 ? (
              <p className="text-sm text-muted-foreground/50 italic">No completed tasks</p>
            ) : (
              <ul className="space-y-1.5">
                {done.map((t) => {
                  const subs = getSubtasks(t.metadata)
                  const doneSubs = subs.filter((s) => subtaskDone(s))
                  return (
                    <li key={t.id}>
                      <div className="text-sm flex items-start gap-2">
                        <span className="text-muted-foreground mt-0.5">•</span>
                        <span className="line-through text-muted-foreground">{t.title}</span>
                      </div>
                      {doneSubs.length > 0 && (
                        <ul className="ml-5 mt-0.5 space-y-0.5">
                          {doneSubs.map((s) => (
                            <li key={s.id} className="text-xs text-muted-foreground/60 flex items-start gap-1.5">
                              <span className="mt-0.5">✓</span>
                              <span>{s.title}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* In Progress — with completed subtasks */}
          {inProgressWithDoneSubs.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2">🔄 In Progress</h3>
              <ul className="space-y-1.5">
                {inProgressWithDoneSubs.map((t) => {
                  const subs = getSubtasks(t.metadata)
                  const doneSubs = subs.filter((s) => subtaskDone(s))
                  const totalSubs = subs.length
                  return (
                    <li key={t.id}>
                      <div className="text-sm flex items-start gap-2">
                        <span className="text-amber-500 mt-0.5">•</span>
                        <span>{t.title}</span>
                        <span className="text-xs text-muted-foreground/50 tabular-nums shrink-0">{doneSubs.length}/{totalSubs}</span>
                      </div>
                      <ul className="ml-5 mt-0.5 space-y-0.5">
                        {doneSubs.map((s) => (
                          <li key={s.id} className="text-xs text-muted-foreground/60 flex items-start gap-1.5">
                            <span className="mt-0.5">✓</span>
                            <span>{s.title}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {/* Plan */}
          <section>
            <h3 className="text-sm font-semibold mb-2">📌 Today&apos;s Plan</h3>
            {plan.length === 0 && planInProgress.length === 0 ? (
              <p className="text-sm text-muted-foreground/50 italic">No tasks planned</p>
            ) : (
              <ul className="space-y-1.5">
                {/* In-progress tasks with remaining subtasks */}
                {planInProgress.map((t) => {
                  const subs = getSubtasks(t.metadata)
                  const pendingSubs = subs.filter((s) => !subtaskDone(s))
                  const doneSubs = subs.filter((s) => subtaskDone(s))
                  return (
                    <li key={t.id}>
                      <div className="text-sm flex items-start gap-2">
                        <span className="text-amber-500 mt-0.5">•</span>
                        <span className="font-medium">{t.title}</span>
                        <span className="text-xs text-muted-foreground/50 tabular-nums shrink-0">{doneSubs.length}/{subs.length}</span>
                      </div>
                      <ul className="ml-5 mt-0.5 space-y-0.5">
                        {pendingSubs.map((s) => {
                          const st = subtaskStatus(s)
                          return (
                            <li key={s.id} className="text-xs flex items-start gap-1.5">
                              {st === 'in-progress' ? (
                                <span className="text-amber-500 mt-0.5">→</span>
                              ) : (
                                <span className="text-muted-foreground/40 mt-0.5">○</span>
                              )}
                              <span className={st === 'in-progress' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>{s.title}</span>
                            </li>
                          )
                        })}
                      </ul>
                    </li>
                  )
                })}
                {/* Top-level todo tasks */}
                {plan.map((t) => (
                  <li key={t.id} className="text-sm flex items-start gap-2">
                    <span className="text-muted-foreground mt-0.5">•</span>
                    <span>{t.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Blocked */}
          <section>
            <h3 className="text-sm font-semibold mb-2">🚧 Blocked</h3>
            {blocked.length === 0 ? (
              <p className="text-sm text-muted-foreground/50 italic">Nothing blocked</p>
            ) : (
              <ul className="space-y-1">
                {blocked.map((t) => (
                  <li key={t.id} className="text-sm flex items-start gap-2">
                    <span className="text-destructive mt-0.5">•</span>
                    <span>{t.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Button onClick={copyToClipboard} className="w-full" variant="outline">
            <ClipboardCopy className="h-4 w-4 mr-2" />
            Copy to Clipboard
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
