import { useState, useMemo, useCallback } from 'react'
import { CheckSquare, ClipboardList, CalendarDays, Inbox, ArrowRight, Flame, Target, Heart, Wallet, ClipboardCheck } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import { PriorityPicker } from './today/priority-picker'
import { TodayChecklist } from './today/today-checklist'
import { HabitStrip } from './today/habit-strip'
import { QuickJournal } from './today/quick-journal'
import { PomodoroTimer } from './today/pomodoro-timer'
import { OnThisDayWidget } from './memories/on-this-day-widget'
import { isReviewDoneThisWeek } from './review/review-helpers'
import { getTodayPriorities, setTodayPriorities } from './today/today-helpers'
import type { Entity } from '@/core/types'

function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export function TodayPage() {
  const { items: allEntities, update, create } = useEntities()
  const { items: allTrackers, create: createTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)
  const navigate = useNavigate()
  const displayName = currentUser?.name?.split(' ')[0] ?? 'there'

  const [priorities, setPriorities] = useState<string[]>(() => getTodayPriorities())

  const today = new Date().toISOString().split('T')[0]
  const todayStart = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }, [])

  // Priority entities
  const priorityEntities = useMemo(
    () => priorities.map((id) => allEntities.find((e) => e.id === id)).filter(Boolean) as Entity[],
    [priorities, allEntities],
  )

  // Candidates for priority picker: active tasks and goals
  const priorityCandidates = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          (e.type === 'task' || e.type === 'goal') &&
          e.status === 'active',
      ),
    [allEntities],
  )

  // Due tasks
  const dueTasks = useMemo(
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

  // Due chores
  const dueChores = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          e.type === 'chore' &&
          e.status !== 'completed' &&
          e.status !== 'archived' &&
          e.dueDate &&
          e.dueDate <= today,
      ),
    [allEntities, today],
  )

  // Today's events
  const todayEvents = useMemo(
    () =>
      allEntities.filter(
        (e) => e.type === 'event' && e.status === 'active' && e.dueDate === today,
      ),
    [allEntities, today],
  )

  // Habits with check-in status
  const habits = useMemo(
    () =>
      allEntities
        .filter((e) => e.type === 'habit' && e.status === 'active')
        .map((habit) => ({
          habit,
          checkedToday: allTrackers.some(
            (t) => t.entityId === habit.id && t.timestamp >= todayStart,
          ),
          streak: typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0,
        })),
    [allEntities, allTrackers, todayStart],
  )

  // Inbox items
  const inboxItems = useMemo(
    () =>
      allEntities.filter(
        (e) => e.type === 'note' && e.metadata.isInbox === true && e.status === 'active',
      ),
    [allEntities],
  )

  // Overall progress
  const allDueItems = [...dueTasks, ...dueChores]
  const completedCount = allDueItems.filter((i) => i.status === 'completed').length
  const habitsChecked = habits.filter((h) => h.checkedToday).length
  const totalItems = allDueItems.length + habits.length
  const doneItems = completedCount + habitsChecked
  const progressPercent = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 100

  const handleSavePriorities = useCallback((ids: string[]) => {
    setTodayPriorities(ids)
    setPriorities(ids)
    notify({ title: 'Priorities set', type: 'success' })
  }, [])

  const toggleItem = useCallback(
    (item: Entity) => {
      update.mutate({
        id: item.id,
        updates: {
          status: item.status === 'completed' ? 'active' : 'completed',
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [update],
  )

  const handleHabitCheckIn = useCallback(
    (habit: Entity) => {
      createTracker.mutate({
        id: crypto.randomUUID(),
        entityId: habit.id,
        value: 1,
        unit: 'done',
        timestamp: new Date().toISOString(),
        ownerId: currentUser?.id ?? '',
      })
      // Increment streak
      const currentStreak = typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
      update.mutate({
        id: habit.id,
        updates: {
          metadata: { ...habit.metadata, streak: currentStreak + 1 },
          updatedAt: new Date().toISOString(),
        },
      })
      notify({ title: `${habit.title} checked in!`, type: 'success' })
    },
    [createTracker, update, currentUser],
  )

  const handleJournalSave = useCallback(
    (text: string) => {
      create.mutate({
        id: crypto.randomUUID(),
        type: 'note',
        title: `Journal — ${new Date().toLocaleDateString()}`,
        status: 'active',
        priority: 'low',
        tags: ['journal'],
        metadata: { body: text, isJournal: true, date: today, mood: '' },
        ownerId: currentUser?.id ?? '',
        visibility: 'private',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      notify({ title: 'Journal entry saved', type: 'success' })
    },
    [create, currentUser, today],
  )

  const handleConvertToTask = useCallback(
    (item: Entity) => {
      create.mutate({
        id: crypto.randomUUID(),
        type: 'task',
        title: item.title,
        description: typeof item.metadata.body === 'string' ? (item.metadata.body as string) : undefined,
        status: 'active',
        priority: 'medium',
        tags: [],
        metadata: {},
        ownerId: currentUser?.id ?? '',
        visibility: 'private',
        dueDate: today,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      update.mutate({
        id: item.id,
        updates: { status: 'archived', updatedAt: new Date().toISOString() },
      })
      notify({ title: 'Converted to task', type: 'success' })
    },
    [create, update, currentUser, today],
  )

  const handleArchiveInbox = useCallback(
    (item: Entity) => {
      update.mutate({
        id: item.id,
        updates: { status: 'archived', updatedAt: new Date().toISOString() },
      })
      notify({ title: 'Archived', type: 'success' })
    },
    [update],
  )

  // Goal progress
  const activeGoals = useMemo(
    () => allEntities.filter((e) => e.type === 'goal' && e.status === 'active' && !e.parentId).slice(0, 5),
    [allEntities],
  )

  // Health summary
  const healthSummary = useMemo(() => {
    const bodyMetrics = allEntities
      .filter((e) => e.type === 'body-metric' && e.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const latestWeight = bodyMetrics.length > 0 ? (bodyMetrics[0].metadata.weight as number | undefined) : undefined
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    const weekISO = weekAgo.toISOString()
    const workouts7d = allEntities.filter(
      (e) => e.type === 'workout' && e.updatedAt >= weekISO,
    ).length
    const todayMoodEntity = allEntities.find(
      (e) => e.type === 'sleep-mood' && (e.metadata.date as string) === today,
    )
    const mood = todayMoodEntity?.metadata.mood as string | undefined
    return { latestWeight, workouts7d, mood }
  }, [allEntities, today])

  // Wealth summary
  const wealthSummary = useMemo(() => {
    const accounts = allEntities.filter((e) => e.type === 'account' && e.status === 'active')
    const cash = accounts.reduce((sum, a) => sum + (typeof a.metadata.balance === 'number' ? (a.metadata.balance as number) : 0), 0)
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)
    const monthISO = monthStart.toISOString()
    const monthTx = allEntities.filter((e) => e.type === 'transaction' && e.createdAt >= monthISO)
    const income = monthTx.filter((t) => t.metadata.txType === 'income').reduce((s, t) => s + (typeof t.metadata.amount === 'number' ? (t.metadata.amount as number) : 0), 0)
    const expense = monthTx.filter((t) => t.metadata.txType === 'expense').reduce((s, t) => s + (typeof t.metadata.amount === 'number' ? (t.metadata.amount as number) : 0), 0)
    return { cash, pl: income - expense }
  }, [allEntities])

  // Memories for On This Day
  const memories = useMemo(
    () => allEntities.filter((e) => e.type === 'memory'),
    [allEntities],
  )

  // Review status
  const reviewDue = useMemo(() => !isReviewDoneThisWeek(), [])

  // Quick stats
  const stats = useMemo(() => {
    const activeHabits = allEntities.filter((e) => e.type === 'habit' && e.status === 'active')
    const bestStreak = activeHabits.reduce((max, h) => {
      const s = typeof h.metadata.streak === 'number' ? (h.metadata.streak as number) : 0
      return s > max ? s : max
    }, 0)
    const activeGoals = allEntities.filter(
      (e) => e.type === 'goal' && e.status === 'active' && !e.parentId,
    ).length
    const todayMood = allEntities.find(
      (e) => e.type === 'sleep-mood' && (e.metadata.date as string) === today,
    )
    const mood = todayMood?.metadata.mood as string | undefined
    return { bestStreak, activeGoals, mood }
  }, [allEntities, today])

  const statCards = [
    { label: 'Streak', value: stats.bestStreak > 0 ? `${stats.bestStreak}d` : '—', icon: <Flame className="h-3.5 w-3.5 text-orange-500" />, path: '/habits' },
    { label: 'Tasks', value: `${dueTasks.length}`, icon: <CheckSquare className="h-3.5 w-3.5 text-blue-500" />, path: '/tasks' },
    { label: 'Goals', value: `${stats.activeGoals}`, icon: <Target className="h-3.5 w-3.5 text-purple-500" />, path: '/goals' },
    { label: 'Mood', value: stats.mood ?? '—', icon: <Heart className="h-3.5 w-3.5 text-pink-500" />, path: '/health' },
  ]

  return (
    <div className="space-y-6 max-w-2xl pb-12">
      {/* Greeting */}
      <section className="space-y-1 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {getGreeting()}, {displayName}
        </h1>
        <p className="text-sm text-muted-foreground">{formatDate(new Date())}</p>
      </section>

      {/* Quick Stats */}
      <div className="grid grid-cols-4 gap-2">
        {statCards.map((s) => (
          <button
            key={s.label}
            onClick={() => navigate(s.path)}
            className="flex flex-col items-center gap-1 rounded-lg border bg-card p-2.5 hover:bg-muted/50 transition-colors"
          >
            {s.icon}
            <span className="text-sm font-semibold">{s.value}</span>
            <span className="text-[10px] text-muted-foreground">{s.label}</span>
          </button>
        ))}
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-3">
        <Progress value={progressPercent} className="h-2 flex-1" />
        <span className="text-xs text-muted-foreground shrink-0">{doneItems}/{totalItems}</span>
      </div>

      {/* Pomodoro Timer */}
      <PomodoroTimer />

      {/* Priorities */}
      {priorities.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <span className="text-yellow-500">&#9733;</span> Today's Priorities
              </CardTitle>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs h-7"
                onClick={() => {
                  setTodayPriorities([])
                  setPriorities([])
                }}
              >
                Reset
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {priorityEntities.map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  <CheckSquare
                    className={`h-4 w-4 shrink-0 ${
                      item.status === 'completed' ? 'text-green-500' : 'text-muted-foreground'
                    }`}
                  />
                  <span
                    className={`text-sm flex-1 ${
                      item.status === 'completed' ? 'line-through text-muted-foreground' : 'font-medium'
                    }`}
                  >
                    {item.title}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <PriorityPicker candidates={priorityCandidates} onSave={handleSavePriorities} />
      )}

      {/* Due Tasks */}
      <TodayChecklist
        title="Due Tasks"
        icon={<CheckSquare className="h-4 w-4 text-muted-foreground" />}
        items={dueTasks}
        onToggle={toggleItem}
      />

      {/* Due Chores */}
      {dueChores.length > 0 && (
        <TodayChecklist
          title="Due Chores"
          icon={<ClipboardList className="h-4 w-4 text-muted-foreground" />}
          items={dueChores}
          onToggle={toggleItem}
        />
      )}

      {/* Today's Events - grouped by time of day */}
      {todayEvents.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              Today's Events
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const getTimeSection = (event: Entity): string => {
                const time = event.metadata.time as string | undefined
                if (!time) return 'All Day'
                const hour = parseInt(time.split(':')[0], 10)
                if (hour < 12) return 'Morning'
                if (hour < 17) return 'Afternoon'
                return 'Evening'
              }

              const sections: Record<string, Entity[]> = {}
              const order = ['Morning', 'Afternoon', 'Evening', 'All Day']
              for (const event of todayEvents) {
                const section = getTimeSection(event)
                if (!sections[section]) sections[section] = []
                sections[section].push(event)
              }

              const nonEmpty = order.filter((s) => sections[s]?.length)
              if (nonEmpty.length <= 1) {
                // No grouping needed
                return (
                  <div className="space-y-2">
                    {todayEvents.map((event) => (
                      <div key={event.id} className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
                        <span className="truncate">{event.title}</span>
                      </div>
                    ))}
                  </div>
                )
              }

              return (
                <div className="space-y-3">
                  {order.map((section) => {
                    const items = sections[section]
                    if (!items?.length) return null
                    return (
                      <div key={section}>
                        <p className="text-xs font-medium text-muted-foreground mb-1">{section}</p>
                        <div className="space-y-1.5">
                          {items.map((event) => (
                            <div key={event.id} className="flex items-center gap-2 text-sm">
                              <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
                              <span className="truncate">{event.title}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </CardContent>
        </Card>
      )}

      {/* Habits */}
      <HabitStrip habits={habits} onCheckIn={handleHabitCheckIn} />

      {/* Goal Progress */}
      {activeGoals.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Target className="h-4 w-4 text-muted-foreground" />
              Goals
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {activeGoals.map((goal) => {
                const p = typeof goal.metadata.progress === 'number' ? (goal.metadata.progress as number) : 0
                return (
                  <div key={goal.id} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="truncate">{goal.title}</span>
                      <span className={`shrink-0 tabular-nums ${p >= 75 ? 'text-green-600' : p >= 25 ? 'text-yellow-600' : 'text-muted-foreground'}`}>
                        {p}%
                      </span>
                    </div>
                    <Progress value={p} className="h-1.5" />
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Health & Wealth — compact row */}
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => navigate('/health')} className="rounded-lg border bg-card p-3 text-left hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-1.5 mb-2">
            <Heart className="h-3.5 w-3.5 text-pink-500" />
            <span className="text-xs font-medium text-muted-foreground">Health</span>
          </div>
          <div className="grid grid-cols-3 gap-1 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Weight</p>
              <p className="text-sm font-medium">{healthSummary.latestWeight ? `${healthSummary.latestWeight}kg` : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Workouts</p>
              <p className="text-sm font-medium">{healthSummary.workouts7d}/7d</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Mood</p>
              <p className="text-sm font-medium capitalize">{healthSummary.mood ?? '—'}</p>
            </div>
          </div>
        </button>
        <button onClick={() => navigate('/wealth')} className="rounded-lg border bg-card p-3 text-left hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-1.5 mb-2">
            <Wallet className="h-3.5 w-3.5 text-green-500" />
            <span className="text-xs font-medium text-muted-foreground">Wealth</span>
          </div>
          <div className="grid grid-cols-2 gap-1 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Cash</p>
              <p className="text-sm font-medium">{wealthSummary.cash.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">P&L</p>
              <p className={`text-sm font-medium ${wealthSummary.pl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {wealthSummary.pl >= 0 ? '+' : ''}{wealthSummary.pl.toLocaleString()}
              </p>
            </div>
          </div>
        </button>
      </div>

      {/* Weekly Review */}
      {reviewDue && (
        <button
          onClick={() => navigate('/review')}
          className="w-full flex items-center gap-3 rounded-lg border border-dashed border-primary/30 p-3 hover:bg-muted/50 transition-colors text-left"
        >
          <ClipboardCheck className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">Weekly Review</p>
            <p className="text-xs text-muted-foreground">Time to reflect on your week</p>
          </div>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      )}

      {/* On This Day */}
      <OnThisDayWidget memories={memories} />

      {/* Inbox Items */}
      {inboxItems.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Inbox className="h-4 w-4 text-muted-foreground" />
              Inbox
              <span className="text-xs text-muted-foreground ml-auto">{inboxItems.length} items</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {inboxItems.map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  <span className="text-sm truncate flex-1">{item.title}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleConvertToTask(item)}
                  >
                    <ArrowRight className="h-3 w-3 mr-1" /> Task
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleArchiveInbox(item)}
                  >
                    Archive
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Journal */}
      <QuickJournal onSave={handleJournalSave} />
    </div>
  )
}
