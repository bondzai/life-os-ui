import { useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router'
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  ClipboardCopy,
  Crosshair,
  Maximize2,
  CalendarDays,
  CalendarRange,
  Mic,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { useWeeklyMetrics } from '@/hooks/use-weekly-metrics'
import { notify } from '@/lib/notify'
import { getSubtasks, subtaskDone, getLastWorkday } from './tasks/task-helpers'
import { getTodayPriorities } from './today/today-helpers'
import type { EntityPriority } from '@/core/types'
import { StepWeeklyPlan } from './review/step-weekly-plan'
import { StepAccomplishments } from './review/step-accomplishments'
import { StepStale } from './review/step-stale'
import { StepHabits } from './review/step-habits'
import { StepSpending } from './review/step-spending'
import { StepReflection } from './review/step-reflection'
import { StepSystemAudit } from './review/step-system-audit'
import { useSystemAudit } from './review/use-system-audit'
import {
  isReviewDoneThisWeek,
  setLastReviewDate,
  daysAgo,
} from './review/review-helpers'
import type { Entity } from '@/core/types'

type ReviewTab = 'plan' | 'standup' | 'daily' | 'weekly'

export function ReviewPage({ embedded }: { embedded?: boolean }) {
  const [tab, setTab] = useState<ReviewTab>('plan')

  const tabs: { id: ReviewTab; label: string; icon: typeof CalendarDays }[] = [
    { id: 'plan', label: 'Plan', icon: Crosshair },
    { id: 'standup', label: 'Standup', icon: Mic },
    { id: 'daily', label: 'Debrief', icon: CalendarDays },
    { id: 'weekly', label: 'Weekly', icon: CalendarRange },
  ]

  return (
    <div className={`${embedded ? '' : 'max-w-3xl'} space-y-5`}>
      {/* Header */}
      <div className="flex items-center gap-3">
        {!embedded && <h1 className="text-xl font-semibold">Review</h1>}
        <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                tab === t.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'plan' ? <StepWeeklyPlan /> : tab === 'standup' ? <StandupReport /> : tab === 'daily' ? <DailyReview /> : <WeeklyReview />}
    </div>
  )
}

// ─── Standup Report ───

const pChar = (p: EntityPriority) => p === 'urgent' ? '⬆⬆' : p === 'high' ? '⬆' : p === 'medium' ? '—' : '⬇'

function StandupReport() {
  const { items: allEntities } = useEntities()
  const navigate = useNavigate()
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
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={copy}>
          <ClipboardCopy className="h-3.5 w-3.5" />
          Copy Markdown
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate('/briefing')}>
          <Maximize2 className="h-3.5 w-3.5" />
          Present
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-8">
        {/* Since */}
        <section>
          <RSH label={`Since ${sinceLabel}`} />
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
          <RSH label="Today" />
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
          <RSH label="Blockers" variant="destructive" />
          <ol className="space-y-1 list-decimal list-inside text-sm text-destructive/80">
            {blocked.map((t) => (
              <li key={t.id}>{t.title}</li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

function RSH({ label, variant }: { label: string; variant?: 'destructive' }) {
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

// ─── Daily Review (Evening Debrief) ───

const DAILY_KEY = 'lyra:daily-review'

function getDailyReviewDone(): boolean {
  const saved = localStorage.getItem(DAILY_KEY)
  if (!saved) return false
  return saved === new Date().toISOString().split('T')[0]
}

function setDailyReviewDone(): void {
  localStorage.setItem(DAILY_KEY, new Date().toISOString().split('T')[0])
}

function DailyReview() {
  const { items: allEntities, create } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)
  const today = new Date().toISOString().split('T')[0]
  const [saved, setSaved] = useState(() => getDailyReviewDone())

  // Today's completed tasks
  const completedToday = useMemo(
    () => allEntities.filter((e) =>
      (e.type === 'task' || e.type === 'chore') &&
      e.status === 'done' &&
      e.updatedAt.split('T')[0] === today,
    ),
    [allEntities, today],
  )

  // Still open (planned but not done)
  const stillOpen = useMemo(
    () => allEntities.filter((e) =>
      (e.type === 'task' || e.type === 'chore') &&
      e.status !== 'done' && e.status !== 'archived' &&
      e.dueDate === today,
    ),
    [allEntities, today],
  )

  // Inbox pending
  const inboxCount = allEntities.filter((e) => e.metadata.isInbox === true && e.status === 'todo').length

  const [winText, setWinText] = useState('')
  const [learnText, setLearnText] = useState('')
  const [tomorrowText, setTomorrowText] = useState('')
  const [energy, setEnergy] = useState<'high' | 'medium' | 'low' | null>(null)

  const canSave = energy !== null

  const handleSave = useCallback(() => {
    const parts: string[] = []
    if (winText.trim()) parts.push(`**Win:** ${winText.trim()}`)
    if (learnText.trim()) parts.push(`**Learned:** ${learnText.trim()}`)
    if (tomorrowText.trim()) parts.push(`**Tomorrow:** ${tomorrowText.trim()}`)
    parts.push(`**Energy:** ${energy}`)
    parts.push(`**Completed:** ${completedToday.length} tasks`)
    parts.push(`**Carried over:** ${stillOpen.length} tasks`)

    create.mutate({
      id: crypto.randomUUID(),
      type: 'note',
      title: `Daily Review — ${new Date().toLocaleDateString()}`,
      status: 'todo',
      priority: 'low',
      tags: ['journal', 'daily-review'],
      metadata: {
        body: parts.join('\n'),
        isJournal: true,
        isDailyReview: true,
        date: today,
        energy,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    setDailyReviewDone()
    setSaved(true)
    notify({ title: 'Daily review saved', type: 'success' })
  }, [winText, learnText, tomorrowText, energy, completedToday, stillOpen, create, currentUser, today])

  if (saved) {
    return (
      <div className="text-center py-16">
        <CheckCircle2 className="h-12 w-12 mx-auto mb-3 text-green-500/50" />
        <p className="text-sm text-muted-foreground/50">Today's review is complete. Rest well.</p>
        <Button variant="ghost" size="sm" className="mt-4" onClick={() => setSaved(false)}>
          Edit
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-center">
          <p className="text-2xl font-semibold text-green-500">{completedToday.length}</p>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground/50 mt-0.5">Completed</p>
        </div>
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-center">
          <p className="text-2xl font-semibold text-amber-500">{stillOpen.length}</p>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground/50 mt-0.5">Carry Over</p>
        </div>
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-center">
          <p className="text-2xl font-semibold text-blue-500">{inboxCount}</p>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground/50 mt-0.5">Inbox</p>
        </div>
      </div>

      {/* Energy level */}
      <section>
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2 block">
          Energy Level
        </label>
        <div className="flex gap-2">
          {([
            { key: 'high' as const, emoji: '🔋', label: 'High' },
            { key: 'medium' as const, emoji: '🔌', label: 'Medium' },
            { key: 'low' as const, emoji: '🪫', label: 'Low' },
          ]).map((e) => (
            <button
              key={e.key}
              onClick={() => setEnergy(e.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                energy === e.key
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              <span>{e.emoji}</span>
              {e.label}
            </button>
          ))}
        </div>
      </section>

      {/* Win */}
      <section>
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2 block">
          🏆 Today's Win
        </label>
        <Textarea
          value={winText}
          onChange={(e) => setWinText(e.target.value)}
          placeholder="What went well today?"
          rows={2}
          className="resize-none text-sm"
        />
      </section>

      {/* Learned */}
      <section>
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2 block">
          🧠 Learned / Insight
        </label>
        <Textarea
          value={learnText}
          onChange={(e) => setLearnText(e.target.value)}
          placeholder="Any insight, lesson, or pattern noticed?"
          rows={2}
          className="resize-none text-sm"
        />
      </section>

      {/* Tomorrow */}
      <section>
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2 block">
          🎯 Tomorrow's Intent
        </label>
        <Textarea
          value={tomorrowText}
          onChange={(e) => setTomorrowText(e.target.value)}
          placeholder="One sentence — what's the main focus tomorrow?"
          rows={1}
          className="resize-none text-sm"
        />
      </section>

      {/* Save */}
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={!canSave} className="flex-1">
          Close the Day
        </Button>
        <Button
          variant="outline"
          className="gap-1.5"
          onClick={() => {
            const lines = [
              `# Daily Review — ${new Date().toLocaleDateString()}`,
              '',
              `Completed: ${completedToday.length} | Carry over: ${stillOpen.length} | Inbox: ${inboxCount}`,
              '',
              ...(winText.trim() ? [`**Win:** ${winText.trim()}`, ''] : []),
              ...(learnText.trim() ? [`**Learned:** ${learnText.trim()}`, ''] : []),
              ...(tomorrowText.trim() ? [`**Tomorrow:** ${tomorrowText.trim()}`, ''] : []),
              ...(energy ? [`**Energy:** ${energy}`] : []),
            ]
            navigator.clipboard.writeText(lines.join('\n'))
            notify({ title: 'Copied', type: 'success' })
          }}
        >
          <ClipboardCopy className="h-3.5 w-3.5" />
          Copy
        </Button>
      </div>
    </div>
  )
}

// ─── Weekly Review (existing wizard) ───

const STEPS = ['Accomplishments', 'Stale Items', 'Habits', 'Spending', 'System Audit', 'Reflection']

function WeeklyReview() {
  const { items: allEntities, update, create } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [step, setStep] = useState(0)
  const [reviewSaved, setReviewSaved] = useState(() => isReviewDoneThisWeek())
  const { projectVelocity, riskDetection, lifeBalance, suggestedPriorities } = useSystemAudit()

  const { weekStart, completed: accomplishments, habitSummaries } = useWeeklyMetrics()
  const today = new Date().toISOString().split('T')[0]

  const staleItems = useMemo(
    () => allEntities.filter((e) => (e.type === 'task' || e.type === 'goal') && e.status === 'todo' && daysAgo(e.updatedAt) >= 14),
    [allEntities],
  )

  const weekTransactions = useMemo(
    () => allEntities.filter((e) => e.type === 'transaction' && ((e.metadata.date as string) || e.createdAt.split('T')[0]) >= weekStart),
    [allEntities, weekStart],
  )

  const monthlyBudget = useMemo(
    () => allEntities.filter((e) => e.type === 'budget' && e.status === 'todo').reduce((sum, b) => sum + (Number(b.metadata.amount) || 0), 0),
    [allEntities],
  )

  const handleArchive = useCallback(
    (item: Entity) => {
      update.mutate({ id: item.id, updates: { status: 'archived', updatedAt: new Date().toISOString() } })
      notify({ title: `"${item.title}" archived`, type: 'success' })
    },
    [update],
  )

  const handleReflectionSave = useCallback(
    (text: string) => {
      create.mutate({
        id: crypto.randomUUID(),
        type: 'note',
        title: `Weekly Review — ${new Date().toLocaleDateString()}`,
        status: 'todo',
        priority: 'low',
        tags: ['journal', 'review'],
        metadata: { body: text, isJournal: true, isReview: true, date: today },
        ownerId: currentUser?.id ?? '',
        visibility: 'private',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      setLastReviewDate()
      setReviewSaved(true)
      notify({ title: 'Weekly review completed!', type: 'success' })
    },
    [create, currentUser, today],
  )

  return (
    <div className="space-y-4">
      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {STEPS.map((name, i) => (
          <div key={name} className="flex items-center gap-2">
            {i > 0 && <div className="w-4 h-px bg-border" />}
            <button
              onClick={() => setStep(i)}
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full transition-colors ${
                i === step
                  ? 'bg-primary text-primary-foreground'
                  : i < step || reviewSaved
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {(i < step || (i === STEPS.length - 1 && reviewSaved)) && <CheckCircle2 className="h-3 w-3" />}
              {i + 1}
            </button>
          </div>
        ))}
        <span className="text-xs text-muted-foreground ml-2">{STEPS[step]}</span>
      </div>

      {step === 0 && <StepAccomplishments items={accomplishments} allEntities={allEntities} />}
      {step === 1 && <StepStale items={staleItems} onArchive={handleArchive} />}
      {step === 2 && <StepHabits habits={habitSummaries} />}
      {step === 3 && <StepSpending transactions={weekTransactions} budgetTotal={monthlyBudget} />}
      {step === 4 && (
        <StepSystemAudit
          projectVelocity={projectVelocity}
          riskDetection={riskDetection}
          lifeBalance={lifeBalance}
          suggestedPriorities={suggestedPriorities}
          onArchive={handleArchive}
        />
      )}
      {step === 5 && <StepReflection onSave={handleReflectionSave} saved={reviewSaved} allEntities={allEntities} />}

      <div className="flex justify-between pt-2">
        <Button variant="outline" size="sm" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            const lines = [
              `# Weekly Review — Week of ${weekStart}`,
              '',
              `## Completed (${accomplishments.length})`,
              ...accomplishments.map((t, i) => `${i + 1}. ${t.title}`),
              '',
              `## Habits`,
              ...habitSummaries.map((h) => `- ${h.habit.title}: ${h.checkIns} check-ins, streak ${h.streak}`),
            ]
            navigator.clipboard.writeText(lines.join('\n'))
            notify({ title: 'Copied', type: 'success' })
          }}
        >
          <ClipboardCopy className="h-3.5 w-3.5" />
          Copy
        </Button>
        <Button size="sm" disabled={step === STEPS.length - 1} onClick={() => setStep((s) => s + 1)}>
          Next <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  )
}
