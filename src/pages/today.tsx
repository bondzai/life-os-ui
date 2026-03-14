import { useState, useMemo, useCallback } from 'react'
import {
  Circle,
  CircleCheck,
  ChevronRight,
  CalendarDays,
  Target,
  Inbox,
  ArrowRight,
  BookOpen,
  Compass,
  Layers,
  BarChart3,
  Brain,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import { PriorityPicker } from './today/priority-picker'
import { CaptureBar } from './today/capture-bar'
import { DailyProtocol } from './today/daily-protocol'
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
function SH({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{children}</h2>
      {action}
    </div>
  )
}

function LinkAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-[11px] text-muted-foreground/50 hover:text-foreground transition-colors flex items-center gap-0.5">
      {label} <ChevronRight className="h-3 w-3" />
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

  // ─── Data queries ───

  const priorityEntities = useMemo(
    () => priorities.map((id) => allEntities.find((e) => e.id === id)).filter(Boolean) as Entity[],
    [priorities, allEntities],
  )

  const priorityCandidates = useMemo(
    () => allEntities.filter((e) => (e.type === 'task' || e.type === 'goal') && e.status === 'active'),
    [allEntities],
  )

  // Due tasks + chores merged, sorted by priority
  const actionItems = useMemo(() => {
    const items = allEntities.filter(
      (e) =>
        (e.type === 'task' || e.type === 'chore') &&
        e.status !== 'completed' &&
        e.status !== 'archived' &&
        e.dueDate &&
        e.dueDate <= today,
    )
    const order = { critical: 0, high: 1, medium: 2, low: 3 }
    items.sort((a, b) => (order[a.priority as keyof typeof order] ?? 2) - (order[b.priority as keyof typeof order] ?? 2))
    return items
  }, [allEntities, today])

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
    () => allEntities.filter((e) => e.metadata.isInbox === true && e.status === 'active'),
    [allEntities],
  )

  // Strategic Direction — top-level goals (no parent)
  const strategicGoals = useMemo(
    () => allEntities.filter((e) => e.type === 'goal' && e.status === 'active' && !e.parentId),
    [allEntities],
  )

  // Active Projects — goals that have children (sub-goals/milestones)
  const activeProjects = useMemo(() => {
    const childParentIds = new Set(
      allEntities.filter((e) => e.type === 'goal' && e.parentId).map((e) => e.parentId!),
    )
    // Projects = goals with children, or top-level goals with progress tracking
    const projects = allEntities.filter(
      (e) =>
        e.type === 'goal' &&
        e.status === 'active' &&
        (childParentIds.has(e.id) || typeof e.metadata.progress === 'number'),
    )
    return projects.slice(0, 5)
  }, [allEntities])

  // Knowledge Growth — recent notes tagged with knowledge/learning/research
  const knowledgeItems = useMemo(() => {
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 14)
    const weekISO = weekAgo.toISOString()
    return allEntities
      .filter(
        (e) =>
          e.type === 'note' &&
          e.status === 'active' &&
          !e.metadata.isInbox &&
          !e.metadata.isJournal &&
          e.createdAt >= weekISO,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5)
  }, [allEntities])

  // ─── Metrics ───

  const habitsChecked = habits.filter((h) => h.checkedToday).length
  const totalItems = actionItems.length + habits.length
  const doneItems = actionItems.filter((i) => i.status === 'completed').length + habitsChecked

  // Focus Score: how many priorities are completed
  const focusScore = useMemo(() => {
    if (priorities.length === 0) return null
    const completed = priorityEntities.filter((e) => e.status === 'completed').length
    return Math.round((completed / priorities.length) * 100)
  }, [priorities, priorityEntities])

  // Knowledge count this week
  const knowledgeThisWeek = useMemo(() => {
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    const weekISO = weekAgo.toISOString()
    return allEntities.filter(
      (e) => e.type === 'note' && e.status === 'active' && !e.metadata.isInbox && !e.metadata.isJournal && e.createdAt >= weekISO,
    ).length
  }, [allEntities])

  const reviewDue = useMemo(() => !isReviewDoneThisWeek(), [])

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
      notify({ title: `${habit.title} done!`, type: 'success' })
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
      <header className="shrink-0 pb-4 flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight truncate">
            {getGreeting()}, {displayName}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">{dateStr}</p>
        </div>
        <div className="flex items-center gap-4">
          {/* Focus Score pill */}
          {focusScore !== null && (
            <div className={`px-3 py-1 rounded-full text-xs font-medium tabular-nums ${
              focusScore >= 100
                ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                : focusScore >= 50
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : 'bg-muted text-muted-foreground'
            }`}>
              Focus {focusScore}%
            </div>
          )}
          {/* Day progress */}
          {totalItems > 0 && (
            <div className="flex items-center gap-2 min-w-[120px]">
              <Progress value={totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 100} className="h-1.5 flex-1" />
              <span className="text-[11px] tabular-nums text-muted-foreground">{doneItems}/{totalItems}</span>
            </div>
          )}
        </div>
      </header>

      {/* ─── Capture Bar ─── */}
      <div className="shrink-0 pb-5">
        <CaptureBar />
      </div>

      {/* ─── Main Grid ─── */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* ═══ LEFT — Actionable (7/12) ═══ */}
        <div className="lg:col-span-7 min-h-0 overflow-y-auto space-y-6 pr-1 scrollbar-thin">

          {/* Today Focus — max 3, the sacred block */}
          <section>
            {priorities.length > 0 ? (
              <>
                <SH action={
                  <button
                    className="text-[11px] text-muted-foreground/50 hover:text-foreground transition-colors"
                    onClick={() => { setTodayPriorities([]); setPriorities([]) }}
                  >
                    Reset
                  </button>
                }>
                  <Target className="h-3 w-3 inline mr-1.5 -mt-px" />
                  Today Focus
                </SH>
                <div className="space-y-0.5">
                  {priorityEntities.map((item, i) => (
                    <button
                      key={item.id}
                      onClick={() => toggleItem(item)}
                      className="flex items-center gap-3 w-full py-3 px-3 rounded-lg hover:bg-muted/50 transition-colors text-left group"
                    >
                      {item.status === 'completed' ? (
                        <CircleCheck className="h-5 w-5 text-green-500 shrink-0" />
                      ) : (
                        <Circle className="h-5 w-5 text-muted-foreground/25 group-hover:text-muted-foreground/50 shrink-0" />
                      )}
                      <span className={`text-sm ${item.status === 'completed' ? 'line-through text-muted-foreground' : 'font-medium'}`}>
                        <span className="text-muted-foreground/30 mr-2 tabular-nums">{i + 1}</span>
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

          {/* Due Items */}
          {actionItems.length > 0 && (
            <section>
              <SH action={<LinkAction label="All tasks" onClick={() => navigate('/tasks')} />}>
                Due ({actionItems.length})
              </SH>
              <div className="space-y-0.5">
                {actionItems.slice(0, 10).map((item) => (
                  <button
                    key={item.id}
                    onClick={() => toggleItem(item)}
                    className="flex items-center gap-3 w-full py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors text-left group"
                  >
                    {item.status === 'completed' ? (
                      <CircleCheck className="h-[18px] w-[18px] text-green-500 shrink-0" />
                    ) : (
                      <Circle className="h-[18px] w-[18px] text-muted-foreground/25 group-hover:text-muted-foreground/50 shrink-0" />
                    )}
                    <span className={`text-sm flex-1 truncate ${item.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>
                      {item.title}
                    </span>
                    {(item.priority === 'high' || item.priority === 'critical') && (
                      <span className="text-[10px] font-medium text-orange-500/80 uppercase">{item.priority}</span>
                    )}
                    {item.type === 'chore' && (
                      <span className="text-[10px] text-muted-foreground/40 uppercase">chore</span>
                    )}
                  </button>
                ))}
                {actionItems.length > 10 && (
                  <button onClick={() => navigate('/tasks')} className="text-xs text-muted-foreground/50 hover:text-foreground pl-3 py-1 transition-colors">
                    +{actionItems.length - 10} more
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Schedule */}
          {todayEvents.length > 0 && (
            <section>
              <SH action={<LinkAction label="Calendar" onClick={() => navigate('/calendar')} />}>
                <CalendarDays className="h-3 w-3 inline mr-1.5 -mt-px" />
                Schedule
              </SH>
              <div className="space-y-0.5">
                {todayEvents.map((event) => (
                  <div key={event.id} className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors">
                    <span className="text-xs tabular-nums text-muted-foreground/60 w-12 shrink-0">
                      {(event.metadata.time as string) ?? 'All day'}
                    </span>
                    <span className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
                    <span className="text-sm truncate">{event.title}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Habits — inline pills */}
          {habits.length > 0 && (
            <section>
              <SH action={<LinkAction label="Habits" onClick={() => navigate('/habits')} />}>
                Habits ({habitsChecked}/{habits.length})
              </SH>
              <div className="flex flex-wrap gap-2">
                {habits.map(({ habit, checkedToday, streak }) => (
                  <button
                    key={habit.id}
                    onClick={() => !checkedToday && handleHabitCheckIn(habit)}
                    disabled={checkedToday}
                    className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all ${
                      checkedToday
                        ? 'bg-green-500/8 text-green-700 dark:text-green-400'
                        : 'bg-muted/40 hover:bg-muted text-foreground'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 transition-colors ${checkedToday ? 'bg-green-500' : 'bg-muted-foreground/20'}`} />
                    {habit.title}
                    {streak > 0 && <span className="text-[11px] text-muted-foreground/50 tabular-nums">{streak}d</span>}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Inbox */}
          {inboxItems.length > 0 && (
            <section>
              <SH>
                <Inbox className="h-3 w-3 inline mr-1.5 -mt-px" />
                Inbox ({inboxItems.length})
              </SH>
              <div className="space-y-0.5">
                {inboxItems.slice(0, 8).map((item) => (
                  <div key={item.id} className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors group">
                    <span className="text-sm flex-1 truncate">{item.title}</span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => handleConvertToTask(item)}>
                        <ArrowRight className="h-3 w-3 mr-1" /> Task
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => handleArchiveInbox(item)}>
                        Done
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Journal — collapsed */}
          <section className="pb-6">
            <button
              onClick={() => setShowJournal((v) => !v)}
              className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              <BookOpen className="h-3 w-3" />
              Quick Journal
              <ChevronRight className={`h-3 w-3 transition-transform ${showJournal ? 'rotate-90' : ''}`} />
            </button>
            {showJournal && (
              <div className="mt-3 space-y-2">
                <Textarea
                  placeholder="What's on your mind?"
                  rows={3}
                  value={journalText}
                  onChange={(e) => setJournalText(e.target.value)}
                  className="resize-none"
                  autoFocus
                />
                <Button size="sm" disabled={!journalText.trim()} onClick={handleJournalSave}>Save</Button>
              </div>
            )}
          </section>
        </div>

        {/* ═══ RIGHT — Cognitive Context (5/12) ═══ */}
        <aside className="lg:col-span-5 min-h-0 overflow-y-auto space-y-4 scrollbar-thin">

          {/* Strategic Direction */}
          <div className="rounded-xl border bg-card/50 p-5">
            <SH action={<LinkAction label="Goals" onClick={() => navigate('/goals')} />}>
              <Compass className="h-3 w-3 inline mr-1.5 -mt-px" />
              Strategic Direction
            </SH>
            {strategicGoals.length === 0 ? (
              <p className="text-sm text-muted-foreground/50">No strategic goals set</p>
            ) : (
              <div className="space-y-2">
                {strategicGoals.slice(0, 5).map((goal) => (
                  <div key={goal.id} className="flex items-start gap-2.5">
                    <span className="text-muted-foreground/30 mt-0.5">→</span>
                    <span className="text-sm">{goal.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Active Projects */}
          {activeProjects.length > 0 && (
            <div className="rounded-xl border bg-card/50 p-5">
              <SH>
                <Layers className="h-3 w-3 inline mr-1.5 -mt-px" />
                Active Projects
              </SH>
              <div className="space-y-3">
                {activeProjects.map((project) => {
                  const p = typeof project.metadata.progress === 'number' ? (project.metadata.progress as number) : 0
                  return (
                    <div key={project.id}>
                      <div className="flex justify-between text-sm mb-1.5">
                        <span className="truncate pr-3">{project.title}</span>
                        <span className="tabular-nums text-muted-foreground/60 text-xs shrink-0">{p}%</span>
                      </div>
                      <Progress value={p} className="h-1" />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Knowledge Growth */}
          <div className="rounded-xl border bg-card/50 p-5">
            <SH action={<LinkAction label="Notes" onClick={() => navigate('/notes')} />}>
              <Brain className="h-3 w-3 inline mr-1.5 -mt-px" />
              Knowledge Growth
            </SH>
            {knowledgeItems.length === 0 ? (
              <p className="text-sm text-muted-foreground/50">No new knowledge this week</p>
            ) : (
              <div className="space-y-2">
                {knowledgeItems.map((item) => {
                  const daysAgo = Math.floor((Date.now() - new Date(item.createdAt).getTime()) / 86400000)
                  return (
                    <div key={item.id} className="flex items-start gap-2.5">
                      <span className="text-primary/40 mt-0.5 text-xs">+</span>
                      <span className="text-sm flex-1 truncate">{item.title}</span>
                      <span className="text-[10px] text-muted-foreground/40 tabular-nums shrink-0">
                        {daysAgo === 0 ? 'today' : `${daysAgo}d`}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Daily Protocol */}
          <div className="rounded-xl border bg-card/50 p-5">
            <SH>Protocol</SH>
            <DailyProtocol />
          </div>

          {/* Clarity Metrics */}
          <div className="rounded-xl border bg-card/50 p-5">
            <SH>
              <BarChart3 className="h-3 w-3 inline mr-1.5 -mt-px" />
              Clarity
            </SH>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <p className={`text-lg font-semibold tabular-nums ${
                  focusScore === null
                    ? 'text-muted-foreground/40'
                    : focusScore >= 100
                      ? 'text-green-600 dark:text-green-400'
                      : focusScore >= 50
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-foreground'
                }`}>
                  {focusScore !== null ? `${focusScore}%` : '—'}
                </p>
                <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wide mt-0.5">Focus</p>
              </div>
              <div className="text-center">
                <p className={`text-lg font-semibold tabular-nums ${inboxItems.length === 0 ? 'text-green-600 dark:text-green-400' : inboxItems.length <= 3 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>
                  {inboxItems.length}
                </p>
                <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wide mt-0.5">Noise</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-semibold tabular-nums">
                  +{knowledgeThisWeek}
                </p>
                <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wide mt-0.5">Knowledge</p>
              </div>
            </div>
          </div>

          {/* Weekly Review nudge */}
          {reviewDue && (
            <button
              onClick={() => navigate('/review')}
              className="w-full rounded-xl border border-dashed border-primary/20 bg-card/50 p-4 text-left hover:bg-muted/50 transition-colors flex items-center gap-3"
            >
              <div className="flex-1">
                <p className="text-sm font-medium">Weekly Review</p>
                <p className="text-[11px] text-muted-foreground/50">Time to reflect on your week</p>
              </div>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40" />
            </button>
          )}
        </aside>
      </div>
    </div>
  )
}
