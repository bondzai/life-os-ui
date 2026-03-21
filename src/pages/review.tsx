import { useState, useMemo, useCallback } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CalendarDays,
  CalendarRange,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import { StepAccomplishments } from './review/step-accomplishments'
import { StepStale } from './review/step-stale'
import { StepHabits } from './review/step-habits'
import { StepSpending } from './review/step-spending'
import { StepReflection } from './review/step-reflection'
import { StepSystemAudit } from './review/step-system-audit'
import { useSystemAudit } from './review/use-system-audit'
import {
  getWeekStart,
  isReviewDoneThisWeek,
  setLastReviewDate,
  daysAgo,
} from './review/review-helpers'
import type { Entity } from '@/core/types'

type ReviewTab = 'daily' | 'weekly'

export function ReviewPage({ embedded }: { embedded?: boolean }) {
  const [tab, setTab] = useState<ReviewTab>('daily')

  return (
    <div className={`${embedded ? '' : 'max-w-2xl'} space-y-5`}>
      {/* Header */}
      <div className="flex items-center gap-3">
        {!embedded && <h1 className="text-xl font-semibold">Review</h1>}
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

      {tab === 'daily' ? <DailyReview /> : <WeeklyReview />}
    </div>
  )
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
      <Button onClick={handleSave} disabled={!canSave} className="w-full">
        Close the Day
      </Button>
    </div>
  )
}

// ─── Weekly Review (existing wizard) ───

const STEPS = ['Accomplishments', 'Stale Items', 'Habits', 'Spending', 'System Audit', 'Reflection']

function WeeklyReview() {
  const { items: allEntities, update, create } = useEntities()
  const { items: allTrackers } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [step, setStep] = useState(0)
  const [reviewSaved, setReviewSaved] = useState(() => isReviewDoneThisWeek())
  const { projectVelocity, riskDetection, lifeBalance, suggestedPriorities } = useSystemAudit()

  const weekStart = getWeekStart()
  const today = new Date().toISOString().split('T')[0]

  const accomplishments = useMemo(
    () => allEntities.filter((e) => (e.type === 'task' || e.type === 'goal') && e.status === 'done' && e.updatedAt.split('T')[0] >= weekStart),
    [allEntities, weekStart],
  )

  const staleItems = useMemo(
    () => allEntities.filter((e) => (e.type === 'task' || e.type === 'goal') && e.status === 'todo' && daysAgo(e.updatedAt) >= 14),
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
        <Button size="sm" disabled={step === STEPS.length - 1} onClick={() => setStep((s) => s + 1)}>
          Next <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  )
}
