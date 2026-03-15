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
import type { Entity } from '@/core/types'

type StandupWorkspace = 'all' | 'work' | 'personal'

interface StandupReportProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: Entity[]
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

export function StandupReport({ open, onOpenChange, tasks }: StandupReportProps) {
  const [ws, setWs] = useState<StandupWorkspace>('all')
  const lastWorkday = useMemo(() => getLastWorkday(), [])
  const lastWorkdayLabel = useMemo(() => formatWorkdayLabel(lastWorkday), [lastWorkday])

  const filtered = useMemo(() => {
    if (ws === 'all') return tasks
    return tasks.filter((t) => t.metadata.workspace === ws)
  }, [tasks, ws])

  const { done, plan, blocked } = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]

    const doneTasks = filtered.filter(
      (t) =>
        t.status === 'completed' &&
        t.updatedAt &&
        new Date(t.updatedAt) >= lastWorkday,
    )

    const planTasks = filtered.filter(
      (t) =>
        t.status === 'active' &&
        (t.dueDate === today || t.priority === 'urgent' || t.priority === 'high'),
    )

    const blockedTasks = filtered.filter((t) => t.status === 'paused')

    return { done: doneTasks, plan: planTasks, blocked: blockedTasks }
  }, [filtered, lastWorkday])

  const wsLabel = ws === 'all' ? '' : ws === 'work' ? ' (Work)' : ' (Personal)'

  const copyToClipboard = () => {
    const sections = [
      `✅ Done${wsLabel} (since ${lastWorkdayLabel}):`,
      done.length > 0 ? done.map((t) => `• ${t.title}`).join('\n') : '• (none)',
      '',
      `📌 Today's Plan${wsLabel}:`,
      plan.length > 0 ? plan.map((t) => `• ${t.title}`).join('\n') : '• (none)',
      '',
      `🚧 Blocked${wsLabel}:`,
      blocked.length > 0 ? blocked.map((t) => `• ${t.title}`).join('\n') : '• (none)',
    ]
    const text = sections.join('\n')
    navigator.clipboard.writeText(text)
    notify({ title: 'Copied to clipboard', type: 'success' })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[450px]">
        <SheetHeader>
          <SheetTitle>Standup Report</SheetTitle>
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
              <ul className="space-y-1">
                {done.map((t) => (
                  <li key={t.id} className="text-sm flex items-start gap-2">
                    <span className="text-muted-foreground mt-0.5">•</span>
                    <span className="line-through text-muted-foreground">{t.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Plan */}
          <section>
            <h3 className="text-sm font-semibold mb-2">📌 Today&apos;s Plan</h3>
            {plan.length === 0 ? (
              <p className="text-sm text-muted-foreground/50 italic">No tasks planned</p>
            ) : (
              <ul className="space-y-1">
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
