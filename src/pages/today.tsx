import { useState, useMemo, useCallback } from 'react'
import {
  CheckSquare,
  ChevronRight,
  Circle,
  CircleCheck,
  CalendarDays,
  Flame,
  Target,
  Heart,
  Wallet,
  Inbox,
  ArrowRight,
  Repeat,
  BookOpen,
  ClipboardCheck,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import { PriorityPicker } from './today/priority-picker'
import { isReviewDoneThisWeek } from './review/review-helpers'
import { getTodayPriorities, setTodayPriorities } from './today/today-helpers'
import type { Entity } from '@/core/types'

function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

/* ─── Section header ─── */
function SectionHeader({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</h2>
      {action}
    </div>
  )
}

/* ─── Clickable row for navigation ─── */
function NavRow({ label, sub, onClick }: { label: string; sub?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 w-full py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors text-left group"
    >
      <span className="text-sm font-medium flex-1">{label}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
    </button>
  )
}

export function TodayPage() {
  const { items: allEntities, update, create } = useEntities()
  const { items: allTrackers, create: createTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)
  const navigate = useNavigate()
  const displayName = currentUser?.name?.split(' ')[0] ?? 'there'

  const [priorities, setPriorities] = useState<string[]>(() => getTodayPriorities())
  const [journalText, setJournalText] = useState('')
  const [showJournal, setShowJournal] = useState(false)

  const today = new Date().toISOString().split('T')[0]
  const todayStart = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }, [])

  // ─── Data ───
  const priorityEntities = useMemo(
    () => priorities.map((id) => allEntities.find((e) => e.id === id)).filter(Boolean) as Entity[],
    [priorities, allEntities],
  )

  const priorityCandidates = useMemo(
    () => allEntities.filter((e) => (e.type === 'task' || e.type === 'goal') && e.status === 'active'),
    [allEntities],
  )

  const dueTasks = useMemo(
    () => allEntities.filter(
      (e) => e.type === 'task' && e.status !== 'completed' && e.status !== 'archived' && e.dueDate && e.dueDate <= today,
    ),
    [allEntities, today],
  )

  const dueChores = useMemo(
    () => allEntities.filter(
      (e) => e.type === 'chore' && e.status !== 'completed' && e.status !== 'archived' && e.dueDate && e.dueDate <= today,
    ),
    [allEntities, today],
  )

  const todayEvents = useMemo(
    () => allEntities
      .filter((e) => e.type === 'event' && e.status === 'active' && e.dueDate === today)
      .sort((a, b) => ((a.metadata.time as string) ?? '').localeCompare((b.metadata.time as string) ?? '')),
    [allEntities, today],
  )

  const habits = useMemo(
    () => allEntities
      .filter((e) => e.type === 'habit' && e.status === 'active')
      .map((habit) => ({
        habit,
        checkedToday: allTrackers.some((t) => t.entityId === habit.id && t.timestamp >= todayStart),
        streak: typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0,
      })),
    [allEntities, allTrackers, todayStart],
  )

  const inboxItems = useMemo(
    () => allEntities.filter((e) => e.type === 'note' && e.metadata.isInbox === true && e.status === 'active'),
    [allEntities],
  )

  const activeGoals = useMemo(
    () => allEntities.filter((e) => e.type === 'goal' && e.status === 'active' && !e.parentId).slice(0, 5),
    [allEntities],
  )

  // Progress
  const actionItems = useMemo(() => {
    const items = [...dueTasks, ...dueChores]
    items.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 }
      return (order[a.priority as keyof typeof order] ?? 2) - (order[b.priority as keyof typeof order] ?? 2)
    })
    return items
  }, [dueTasks, dueChores])

  const habitsChecked = habits.filter((h) => h.checkedToday).length
  const totalItems = actionItems.length + habits.length
  const doneItems = actionItems.filter((i) => i.status === 'completed').length + habitsChecked
  const progressPercent = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 100

  const reviewDue = useMemo(() => !isReviewDoneThisWeek(), [])

  // Health summary
  const healthSummary = useMemo(() => {
    const bodyMetrics = allEntities
      .filter((e) => e.type === 'body-metric' && e.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const latestWeight = bodyMetrics.length > 0 ? (bodyMetrics[0].metadata.weight as number | undefined) : undefined
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    const workouts7d = allEntities.filter((e) => e.type === 'workout' && e.updatedAt >= weekAgo.toISOString()).length
    return { latestWeight, workouts7d }
  }, [allEntities])

  // Wealth summary
  const wealthSummary = useMemo(() => {
    const accounts = allEntities.filter((e) => e.type === 'account' && e.status === 'active')
    const cash = accounts.reduce((sum, a) => sum + (typeof a.metadata.balance === 'number' ? (a.metadata.balance as number) : 0), 0)
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)
    const monthTx = allEntities.filter((e) => e.type === 'transaction' && e.createdAt >= monthStart.toISOString())
    const income = monthTx.filter((t) => t.metadata.txType === 'income').reduce((s, t) => s + (typeof t.metadata.amount === 'number' ? (t.metadata.amount as number) : 0), 0)
    const expense = monthTx.filter((t) => t.metadata.txType === 'expense').reduce((s, t) => s + (typeof t.metadata.amount === 'number' ? (t.metadata.amount as number) : 0), 0)
    return { cash, pl: income - expense }
  }, [allEntities])

  // Best streak
  const bestStreak = useMemo(() => {
    return allEntities
      .filter((e) => e.type === 'habit' && e.status === 'active')
      .reduce((max, h) => {
        const s = typeof h.metadata.streak === 'number' ? (h.metadata.streak as number) : 0
        return s > max ? s : max
      }, 0)
  }, [allEntities])

  // ─── Handlers ───
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

  const handleJournalSave = useCallback(() => {
    if (!journalText.trim()) return
    create.mutate({
      id: crypto.randomUUID(),
      type: 'note',
      title: `Journal — ${new Date().toLocaleDateString()}`,
      status: 'active',
      priority: 'low',
      tags: ['journal'],
      metadata: { body: journalText.trim(), isJournal: true, date: today, mood: '' },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    setJournalText('')
    setShowJournal(false)
    notify({ title: 'Journal saved', type: 'success' })
  }, [create, currentUser, today, journalText])

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
      update.mutate({ id: item.id, updates: { status: 'archived', updatedAt: new Date().toISOString() } })
      notify({ title: 'Converted to task', type: 'success' })
    },
    [create, update, currentUser, today],
  )

  const handleArchiveInbox = useCallback(
    (item: Entity) => {
      update.mutate({ id: item.id, updates: { status: 'archived', updatedAt: new Date().toISOString() } })
      notify({ title: 'Archived', type: 'success' })
    },
    [update],
  )

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="h-[calc(100vh-5rem)] flex flex-col">
      {/* ─── Header ─── */}
      <header className="shrink-0 pb-6">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {getGreeting()}, {displayName}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">{dateStr}</p>
          </div>
          {totalItems > 0 && (
            <div className="flex items-center gap-2.5 min-w-[160px]">
              <Progress value={progressPercent} className="h-1.5 flex-1" />
              <span className="text-xs tabular-nums text-muted-foreground">{progressPercent}%</span>
            </div>
          )}
        </div>
      </header>

      {/* ─── Main grid ─── */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ─── Left column: actionable (2/3) ─── */}
        <div className="lg:col-span-2 flex flex-col gap-6 min-h-0 overflow-y-auto pr-1">
          {/* Priorities */}
          <section>
            {priorities.length > 0 ? (
              <>
                <SectionHeader
                  action={
                    <button
                      className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => { setTodayPriorities([]); setPriorities([]) }}
                    >
                      Reset
                    </button>
                  }
                >
                  Priorities
                </SectionHeader>
                <div className="space-y-0.5">
                  {priorityEntities.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => toggleItem(item)}
                      className="flex items-center gap-3 w-full py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors text-left group"
                    >
                      {item.status === 'completed' ? (
                        <CircleCheck className="h-[18px] w-[18px] text-green-500 shrink-0" />
                      ) : (
                        <Circle className="h-[18px] w-[18px] text-muted-foreground/30 group-hover:text-muted-foreground/60 shrink-0" />
                      )}
                      <span className={`text-sm font-medium ${item.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>
                        {item.title}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <PriorityPicker candidates={priorityCandidates} onSave={handleSavePriorities} />
            )}
          </section>

          {/* Due Today */}
          {actionItems.length > 0 && (
            <section>
              <SectionHeader
                action={
                  <button onClick={() => navigate('/tasks')} className="text-[11px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
                    View all <ChevronRight className="h-3 w-3" />
                  </button>
                }
              >
                Due Today ({actionItems.length})
              </SectionHeader>
              <div className="space-y-0.5">
                {actionItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => toggleItem(item)}
                    className="flex items-center gap-3 w-full py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors text-left group"
                  >
                    {item.status === 'completed' ? (
                      <CircleCheck className="h-[18px] w-[18px] text-green-500 shrink-0" />
                    ) : (
                      <Circle className="h-[18px] w-[18px] text-muted-foreground/30 group-hover:text-muted-foreground/60 shrink-0" />
                    )}
                    <span className={`text-sm flex-1 ${item.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>
                      {item.title}
                    </span>
                    {item.priority === 'high' || item.priority === 'critical' ? (
                      <span className="text-[10px] font-medium text-orange-500 uppercase">{item.priority}</span>
                    ) : null}
                    {item.type === 'chore' && (
                      <span className="text-[10px] text-muted-foreground/50 uppercase">chore</span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Habits */}
          {habits.length > 0 && (
            <section>
              <SectionHeader>
                Habits ({habitsChecked}/{habits.length})
              </SectionHeader>
              <div className="flex flex-wrap gap-2">
                {habits.map(({ habit, checkedToday, streak }) => (
                  <button
                    key={habit.id}
                    onClick={() => !checkedToday && handleHabitCheckIn(habit)}
                    disabled={checkedToday}
                    className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      checkedToday
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted/50 hover:bg-muted text-foreground'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${checkedToday ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                    {habit.title}
                    {streak > 0 && (
                      <span className="text-xs text-muted-foreground">{streak}d</span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Inbox */}
          {inboxItems.length > 0 && (
            <section>
              <SectionHeader>
                Inbox ({inboxItems.length})
              </SectionHeader>
              <div className="space-y-0.5">
                {inboxItems.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors group">
                    <Inbox className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                    <span className="text-sm flex-1 truncate">{item.title}</span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => handleConvertToTask(item)}>
                        <ArrowRight className="h-3 w-3 mr-1" /> Task
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => handleArchiveInbox(item)}>
                        Done
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Journal — collapsible */}
          <section className="pb-4">
            <button
              onClick={() => setShowJournal((v) => !v)}
              className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors mb-3"
            >
              <BookOpen className="h-3.5 w-3.5" />
              Quick Journal
              <ChevronRight className={`h-3 w-3 transition-transform ${showJournal ? 'rotate-90' : ''}`} />
            </button>
            {showJournal && (
              <div className="space-y-2">
                <Textarea
                  placeholder="What's on your mind?"
                  rows={3}
                  value={journalText}
                  onChange={(e) => setJournalText(e.target.value)}
                  className="resize-none"
                />
                <Button size="sm" disabled={!journalText.trim()} onClick={handleJournalSave}>
                  Save
                </Button>
              </div>
            )}
          </section>
        </div>

        {/* ─── Right column: glanceable info (1/3) ─── */}
        <aside className="flex flex-col gap-4 min-h-0 overflow-y-auto">
          {/* Schedule */}
          <div className="rounded-xl border bg-card p-4">
            <SectionHeader
              action={
                <button onClick={() => navigate('/calendar')} className="text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                  Open
                </button>
              }
            >
              <CalendarDays className="h-3.5 w-3.5 inline mr-1.5 -mt-0.5" />
              Schedule
            </SectionHeader>
            {todayEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events today</p>
            ) : (
              <div className="space-y-2">
                {todayEvents.map((event) => (
                  <div key={event.id} className="flex items-start gap-3">
                    <span className="text-xs tabular-nums text-muted-foreground w-11 pt-0.5 shrink-0">
                      {(event.metadata.time as string) ?? 'All day'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{event.title}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Goals */}
          {activeGoals.length > 0 && (
            <div className="rounded-xl border bg-card p-4">
              <SectionHeader
                action={
                  <button onClick={() => navigate('/goals')} className="text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                    Open
                  </button>
                }
              >
                <Target className="h-3.5 w-3.5 inline mr-1.5 -mt-0.5" />
                Goals
              </SectionHeader>
              <div className="space-y-3">
                {activeGoals.map((goal) => {
                  const p = typeof goal.metadata.progress === 'number' ? (goal.metadata.progress as number) : 0
                  return (
                    <div key={goal.id}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="truncate pr-2">{goal.title}</span>
                        <span className="tabular-nums text-muted-foreground shrink-0">{p}%</span>
                      </div>
                      <Progress value={p} className="h-1" />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Quick stats */}
          <div className="rounded-xl border bg-card p-4">
            <SectionHeader>Overview</SectionHeader>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => navigate('/habits')} className="text-left p-2 rounded-lg hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-1.5 mb-1">
                  <Flame className="h-3.5 w-3.5 text-orange-500" />
                  <span className="text-[11px] text-muted-foreground">Streak</span>
                </div>
                <p className="text-lg font-semibold tabular-nums">{bestStreak > 0 ? `${bestStreak}d` : '—'}</p>
              </button>
              <button onClick={() => navigate('/tasks')} className="text-left p-2 rounded-lg hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-1.5 mb-1">
                  <CheckSquare className="h-3.5 w-3.5 text-blue-500" />
                  <span className="text-[11px] text-muted-foreground">Due</span>
                </div>
                <p className="text-lg font-semibold tabular-nums">{actionItems.length}</p>
              </button>
              <button onClick={() => navigate('/health')} className="text-left p-2 rounded-lg hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-1.5 mb-1">
                  <Heart className="h-3.5 w-3.5 text-pink-500" />
                  <span className="text-[11px] text-muted-foreground">Health</span>
                </div>
                <p className="text-sm font-medium tabular-nums">
                  {healthSummary.latestWeight ? `${healthSummary.latestWeight}kg` : '—'}
                  <span className="text-muted-foreground text-xs ml-1">{healthSummary.workouts7d}/7</span>
                </p>
              </button>
              <button onClick={() => navigate('/wealth')} className="text-left p-2 rounded-lg hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-1.5 mb-1">
                  <Wallet className="h-3.5 w-3.5 text-green-500" />
                  <span className="text-[11px] text-muted-foreground">Wealth</span>
                </div>
                <p className={`text-sm font-medium tabular-nums ${wealthSummary.pl >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                  {wealthSummary.pl >= 0 ? '+' : ''}{wealthSummary.pl.toLocaleString()}
                </p>
              </button>
            </div>
          </div>

          {/* Review nudge */}
          {reviewDue && (
            <button
              onClick={() => navigate('/review')}
              className="rounded-xl border border-dashed border-primary/30 bg-card p-4 text-left hover:bg-muted/50 transition-colors flex items-center gap-3"
            >
              <ClipboardCheck className="h-4 w-4 text-primary shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium">Weekly Review</p>
                <p className="text-xs text-muted-foreground">Time to reflect</p>
              </div>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}

          {/* Quick links */}
          <div className="rounded-xl border bg-card p-4">
            <SectionHeader>Navigate</SectionHeader>
            <div className="space-y-0.5 -mx-3">
              <NavRow label="Goals" sub={`${activeGoals.length} active`} onClick={() => navigate('/goals')} />
              <NavRow label="Calendar" onClick={() => navigate('/calendar')} />
              <NavRow label="Notes" onClick={() => navigate('/notes')} />
              <NavRow label="Habits" sub={`${habitsChecked}/${habits.length}`} onClick={() => navigate('/habits')} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
