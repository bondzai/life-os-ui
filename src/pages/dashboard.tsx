import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { CheckSquare, Target, Repeat, Plus, Heart, Wallet, ClipboardCheck, Flame, Trophy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { useEntities, useTrackers } from '@/core/hooks'
import { EntityDialog } from '@/core/components/entity-dialog'
import { useAuthStore } from '@/stores/auth-store'
import { DailyBriefWidget } from '@/pages/ai/daily-brief-widget'
import { OnThisDayWidget } from '@/pages/memories/on-this-day-widget'
import { isReviewDoneThisWeek } from '@/pages/review/review-helpers'
import type { Entity, EntityType, EntityStatus, EntityPriority } from '@/core/types'

export function DashboardPage() {
  const { items: allEntities, update, create } = useEntities()
  const { items: allTrackers } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)
  const navigate = useNavigate()

  const [quickAddType, setQuickAddType] = useState<EntityType | null>(null)

  const today = new Date().toISOString().split('T')[0]

  // Today's tasks: due today or overdue and not completed
  const todaysTasks = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          e.type === 'task' &&
          e.status !== 'completed' &&
          e.status !== 'archived' &&
          e.dueDate &&
          e.dueDate <= today,
      ),
    [allEntities, today],
  )

  // Active goals with progress
  const activeGoals = useMemo(
    () =>
      allEntities
        .filter((e) => e.type === 'goal' && e.status === 'active' && !e.parentId)
        .slice(0, 5),
    [allEntities],
  )

  // Active habits with today's check-in status
  const habits = useMemo(() => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayISO = todayStart.toISOString()

    return allEntities
      .filter((e) => e.type === 'habit' && e.status === 'active')
      .map((habit) => {
        const checkedToday = allTrackers.some(
          (t) => t.entityId === habit.id && t.timestamp >= todayISO,
        )
        return { ...habit, checkedToday }
      })
  }, [allEntities, allTrackers])

  // Habit completion rate (this week)
  const habitRate = useMemo(() => {
    const activeHabits = allEntities.filter((e) => e.type === 'habit' && e.status === 'active')
    if (activeHabits.length === 0) return null
    const weekStart = new Date()
    weekStart.setDate(weekStart.getDate() - weekStart.getDay())
    weekStart.setHours(0, 0, 0, 0)
    const weekISO = weekStart.toISOString()
    const daysSoFar = new Date().getDay() + 1
    const totalSlots = activeHabits.length * daysSoFar
    const checked = allTrackers.filter(
      (t) => t.timestamp >= weekISO && activeHabits.some((h) => h.id === t.entityId),
    ).length
    return totalSlots > 0 ? Math.round((checked / totalSlots) * 100) : 0
  }, [allEntities, allTrackers])

  // Health summary
  const healthSummary = useMemo(() => {
    const weights = allEntities
      .filter((e) => e.type === 'body-metric' && e.metadata.metricType === 'weight')
      .sort((a, b) => ((b.metadata.date as string) || '').localeCompare((a.metadata.date as string) || ''))
    const latestWeight = weights[0]?.metadata.value as number | undefined

    const todayMood = allEntities.find(
      (e) => e.type === 'sleep-mood' && (e.metadata.date as string) === today,
    )
    const mood = todayMood?.metadata.mood as string | undefined

    const weekStart = new Date()
    weekStart.setDate(weekStart.getDate() - 7)
    const weekISO = weekStart.toISOString().split('T')[0]
    const workouts7d = allEntities.filter(
      (e) => e.type === 'workout' && ((e.metadata.date as string) || '') >= weekISO,
    ).length

    return { latestWeight, mood, workouts7d }
  }, [allEntities, today])

  // Wealth summary
  const wealthSummary = useMemo(() => {
    const accounts = allEntities.filter((e) => e.type === 'account' && e.status === 'active')
    const cash = accounts.reduce((sum, a) => sum + (Number(a.metadata.balance) || 0), 0)

    const monthPrefix = today.slice(0, 7)
    const monthTx = allEntities.filter(
      (e) => e.type === 'transaction' && ((e.metadata.date as string) || '').startsWith(monthPrefix),
    )
    const income = monthTx.filter((t) => t.metadata.txType === 'income').reduce((s, t) => s + (Number(t.metadata.amount) || 0), 0)
    const expense = monthTx.filter((t) => t.metadata.txType === 'expense').reduce((s, t) => s + (Number(t.metadata.amount) || 0), 0)
    const pl = income - expense

    return { cash, pl }
  }, [allEntities, today])

  const memories = useMemo(() => allEntities.filter((e) => e.type === 'memory'), [allEntities])

  const reviewDue = !isReviewDoneThisWeek()

  const toggleTaskComplete = (task: Entity) => {
    update.mutate({
      id: task.id,
      updates: {
        status: task.status === 'completed' ? 'active' : 'completed',
        updatedAt: new Date().toISOString(),
      },
    })
  }

  const handleQuickAdd = (values: Record<string, unknown>) => {
    if (!quickAddType) return
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    create.mutate({
      id: crypto.randomUUID(),
      type: quickAddType,
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'active',
      priority: (values.priority as EntityPriority) || 'medium',
      tags,
      metadata: quickAddType === 'goal' ? { progress: 0 } : {},
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  const getProgress = (goal: Entity) =>
    typeof goal.metadata.progress === 'number' ? goal.metadata.progress : 0

  const formatTHB = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 0 })

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {/* Daily Brief */}
      <DailyBriefWidget />

      {/* Today's Tasks */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <CheckSquare className="h-4 w-4 text-muted-foreground" />
            Today's Tasks
          </CardTitle>
        </CardHeader>
        <CardContent>
          {todaysTasks.length === 0 ? (
            <p className="text-sm text-green-600">All caught up! No tasks due.</p>
          ) : (
            <div className="space-y-2">
              {todaysTasks.map((task) => (
                <div key={task.id} className="flex items-center gap-2">
                  <Checkbox
                    checked={task.status === 'completed'}
                    onCheckedChange={() => toggleTaskComplete(task)}
                  />
                  <span className="text-sm truncate flex-1">{task.title}</span>
                  {task.dueDate && task.dueDate < today && (
                    <span className="text-xs text-destructive shrink-0">overdue</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Motivational message when all tasks done */}
      {todaysTasks.length === 0 && (
        <Card className="border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20">
          <CardContent className="p-3 flex items-center gap-3">
            <Trophy className="h-5 w-5 text-yellow-500 shrink-0" />
            <div>
              <p className="text-sm font-medium text-green-700 dark:text-green-300">All tasks done!</p>
              <p className="text-xs text-green-600 dark:text-green-400">You're on top of everything. Great job!</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Goal Progress */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Target className="h-4 w-4 text-muted-foreground" />
            Goal Progress
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activeGoals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active goals.</p>
          ) : (
            <div className="space-y-3">
              {activeGoals.map((goal) => {
                const p = getProgress(goal)
                return (
                  <div key={goal.id} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="truncate">{goal.title}</span>
                      <span className={`shrink-0 ${p >= 75 ? 'text-green-600' : p >= 25 ? 'text-yellow-600' : 'text-muted-foreground'}`}>
                        {p}%
                      </span>
                    </div>
                    <Progress value={p} className="h-2" />
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Habits */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Repeat className="h-4 w-4 text-muted-foreground" />
            Habits
            {habitRate !== null && (
              <span className="ml-auto text-xs text-muted-foreground">{habitRate}% this week</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {habits.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active habits.</p>
          ) : (
            <div className="space-y-2">
              {habits.map((habit) => (
                <div key={habit.id} className="flex items-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      habit.checkedToday ? 'bg-green-500' : 'bg-muted-foreground/30'
                    }`}
                  />
                  <span className="text-sm truncate flex-1">{habit.title}</span>
                  {typeof habit.metadata.streak === 'number' && (habit.metadata.streak as number) > 0 && (
                    <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-0.5">
                      <Flame className="h-3 w-3 text-orange-500" />
                      {habit.metadata.streak as number}d
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Health Summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Heart className="h-4 w-4 text-muted-foreground" />
            Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Weight</p>
              <p className="text-sm font-medium">
                {healthSummary.latestWeight ? `${healthSummary.latestWeight} kg` : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Workouts</p>
              <p className="text-sm font-medium">{healthSummary.workouts7d}/7d</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Mood</p>
              <p className="text-sm font-medium capitalize">{healthSummary.mood || '—'}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Wealth Snapshot */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Wallet className="h-4 w-4 text-muted-foreground" />
            Wealth
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Cash</p>
              <p className="text-sm font-medium">{formatTHB(wealthSummary.cash)} THB</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Monthly P&L</p>
              <p className={`text-sm font-medium ${wealthSummary.pl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {wealthSummary.pl >= 0 ? '+' : ''}{formatTHB(wealthSummary.pl)} THB
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Weekly Review Prompt */}
      {reviewDue && (
        <Card className="border-dashed border-primary/30">
          <CardContent className="p-3 flex items-center gap-3">
            <ClipboardCheck className="h-5 w-5 text-primary shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium">Weekly Review</p>
              <p className="text-xs text-muted-foreground">Time to reflect on your week</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => navigate('/review')}>
              Start
            </Button>
          </CardContent>
        </Card>
      )}

      {/* On This Day */}
      <OnThisDayWidget memories={memories} />

      {/* Quick Add */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Plus className="h-4 w-4 text-muted-foreground" />
            Quick Add
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => setQuickAddType('task')}>
              <CheckSquare className="h-3.5 w-3.5 mr-1" /> Task
            </Button>
            <Button size="sm" variant="outline" onClick={() => setQuickAddType('goal')}>
              <Target className="h-3.5 w-3.5 mr-1" /> Goal
            </Button>
            <Button size="sm" variant="outline" onClick={() => setQuickAddType('event')}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Event
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Quick add dialog */}
      {quickAddType && (
        <EntityDialog
          open={!!quickAddType}
          onOpenChange={(open) => !open && setQuickAddType(null)}
          entityType={quickAddType}
          title={`New ${quickAddType}`}
          onSubmit={handleQuickAdd}
        />
      )}
    </div>
  )
}
