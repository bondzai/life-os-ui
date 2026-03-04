import { useState, useMemo, useCallback } from 'react'
import { ChevronLeft, ChevronRight, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import { StepAccomplishments } from './review/step-accomplishments'
import { StepStale } from './review/step-stale'
import { StepHabits } from './review/step-habits'
import { StepSpending } from './review/step-spending'
import { StepReflection } from './review/step-reflection'
import {
  getWeekStart,
  isReviewDoneThisWeek,
  setLastReviewDate,
  daysAgo,
} from './review/review-helpers'
import type { Entity } from '@/core/types'

const STEPS = ['Accomplishments', 'Stale Items', 'Habits', 'Spending', 'Reflection']

export function ReviewPage() {
  const { items: allEntities, update, create } = useEntities()
  const { items: allTrackers } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [step, setStep] = useState(0)
  const [reviewSaved, setReviewSaved] = useState(() => isReviewDoneThisWeek())

  const weekStart = getWeekStart()
  const today = new Date().toISOString().split('T')[0]

  // Step 1: Accomplishments — completed this week
  const accomplishments = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          (e.type === 'task' || e.type === 'goal') &&
          e.status === 'completed' &&
          e.updatedAt.split('T')[0] >= weekStart,
      ),
    [allEntities, weekStart],
  )

  // Step 2: Stale items — active but not updated in 14+ days
  const staleItems = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          (e.type === 'task' || e.type === 'goal') &&
          e.status === 'active' &&
          daysAgo(e.updatedAt) >= 14,
      ),
    [allEntities],
  )

  // Step 3: Habits with weekly check-in counts
  const habitSummaries = useMemo(() => {
    const habits = allEntities.filter((e) => e.type === 'habit' && e.status === 'active')
    return habits.map((habit) => {
      const checkIns = allTrackers.filter(
        (t) => t.entityId === habit.id && t.timestamp.split('T')[0] >= weekStart,
      ).length
      const streak = typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
      return { habit, checkIns, streak }
    })
  }, [allEntities, allTrackers, weekStart])

  // Step 4: This week's transactions + monthly budget total
  const weekTransactions = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          e.type === 'transaction' &&
          ((e.metadata.date as string) || e.createdAt.split('T')[0]) >= weekStart,
      ),
    [allEntities, weekStart],
  )

  const monthlyBudget = useMemo(
    () =>
      allEntities
        .filter((e) => e.type === 'budget' && e.status === 'active')
        .reduce((sum, b) => sum + (Number(b.metadata.amount) || 0), 0),
    [allEntities],
  )

  const handleArchive = useCallback(
    (item: Entity) => {
      update.mutate({
        id: item.id,
        updates: { status: 'archived', updatedAt: new Date().toISOString() },
      })
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
        status: 'active',
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
    <div className="max-w-2xl space-y-4">
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
              {(i < step || (i === STEPS.length - 1 && reviewSaved)) && (
                <CheckCircle2 className="h-3 w-3" />
              )}
              {i + 1}
            </button>
          </div>
        ))}
        <span className="text-xs text-muted-foreground ml-2">{STEPS[step]}</span>
      </div>

      {/* Step content */}
      {step === 0 && <StepAccomplishments items={accomplishments} />}
      {step === 1 && <StepStale items={staleItems} onArchive={handleArchive} />}
      {step === 2 && <StepHabits habits={habitSummaries} />}
      {step === 3 && <StepSpending transactions={weekTransactions} budgetTotal={monthlyBudget} />}
      {step === 4 && <StepReflection onSave={handleReflectionSave} saved={reviewSaved} />}

      {/* Navigation */}
      <div className="flex justify-between pt-2">
        <Button
          variant="outline"
          size="sm"
          disabled={step === 0}
          onClick={() => setStep((s) => s - 1)}
        >
          <ChevronLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <Button
          size="sm"
          disabled={step === STEPS.length - 1}
          onClick={() => setStep((s) => s + 1)}
        >
          Next <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  )
}
