import { useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router'
import {
  CheckSquare,
  Target,
  Flame,
  Heart,
  ArrowRight,
  Inbox,
  Clock,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import type { Entity } from '@/core/types'

// --- helpers ---

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

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

const TYPE_COLORS: Record<string, string> = {
  task: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  goal: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  habit: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  note: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  event: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  memory: 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
  workout: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  book: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  skill: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  chore: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
}

// --- component ---

export function DashboardPage() {
  const { items: allEntities, update } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)
  const navigate = useNavigate()

  const today = new Date().toISOString().split('T')[0]
  const displayName = currentUser?.name?.split(' ')[0] ?? 'there'

  // Section 2: Today's focus tasks (due today or overdue, max 5)
  const focusTasks = useMemo(
    () =>
      allEntities
        .filter(
          (e) =>
            e.type === 'task' &&
            e.status !== 'completed' &&
            e.status !== 'archived' &&
            e.dueDate &&
            e.dueDate <= today,
        )
        .sort((a, b) => {
          const prio: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
          return (prio[a.priority] ?? 2) - (prio[b.priority] ?? 2)
        })
        .slice(0, 5),
    [allEntities, today],
  )

  // Section 3: Quick stats
  const stats = useMemo(() => {
    // Habit streak: best current streak
    const activeHabits = allEntities.filter((e) => e.type === 'habit' && e.status === 'active')
    const bestStreak = activeHabits.reduce((max, h) => {
      const s = typeof h.metadata.streak === 'number' ? (h.metadata.streak as number) : 0
      return s > max ? s : max
    }, 0)

    // Tasks remaining today
    const tasksRemaining = allEntities.filter(
      (e) =>
        e.type === 'task' &&
        e.status !== 'completed' &&
        e.status !== 'archived' &&
        e.dueDate &&
        e.dueDate <= today,
    ).length

    // Active goals
    const activeGoals = allEntities.filter(
      (e) => e.type === 'goal' && e.status === 'active' && !e.parentId,
    ).length

    // Today's mood
    const todayMood = allEntities.find(
      (e) => e.type === 'sleep-mood' && (e.metadata.date as string) === today,
    )
    const mood = todayMood?.metadata.mood as string | undefined

    return { bestStreak, tasksRemaining, activeGoals, mood }
  }, [allEntities, today])

  // Section 4: Recent activity
  const recentActivity = useMemo(
    () =>
      [...allEntities]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 8),
    [allEntities],
  )

  // Section 5: Inbox items
  const inboxItems = useMemo(
    () =>
      allEntities.filter(
        (e) => e.type === 'note' && e.metadata.isInbox === true && e.status === 'active',
      ),
    [allEntities],
  )

  const toggleTaskComplete = useCallback(
    (task: Entity) => {
      update.mutate({
        id: task.id,
        updates: {
          status: task.status === 'completed' ? 'active' : 'completed',
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [update],
  )

  const statCards = [
    {
      label: 'Streak',
      value: stats.bestStreak > 0 ? `${stats.bestStreak} day streak` : 'No streak',
      icon: <Flame className="h-4 w-4 text-orange-500" />,
      path: '/habits',
    },
    {
      label: 'Tasks',
      value: stats.tasksRemaining > 0 ? `${stats.tasksRemaining} remaining` : 'All done',
      icon: <CheckSquare className="h-4 w-4 text-blue-500" />,
      path: '/tasks',
    },
    {
      label: 'Goals',
      value: `${stats.activeGoals} active`,
      icon: <Target className="h-4 w-4 text-purple-500" />,
      path: '/goals',
    },
    {
      label: 'Mood',
      value: stats.mood ? stats.mood : 'Not logged',
      icon: <Heart className="h-4 w-4 text-pink-500" />,
      path: '/health',
    },
  ]

  return (
    <div className="max-w-2xl space-y-8 pb-12">
      {/* Section 1: Greeting + Date */}
      <section className="space-y-1 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {getGreeting()}, {displayName}
        </h1>
        <p className="text-sm text-muted-foreground">{formatDate(new Date())}</p>
      </section>

      {/* Section 2: Today's Focus */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Today's Focus
          </h2>
          <button
            onClick={() => navigate('/tasks')}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            View all tasks <ArrowRight className="h-3 w-3" />
          </button>
        </div>

        {focusTasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-muted-foreground/20 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing due today — enjoy your day.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {focusTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors group"
              >
                <Checkbox
                  checked={task.status === 'completed'}
                  onCheckedChange={() => toggleTaskComplete(task)}
                />
                <span className="text-sm flex-1 truncate">{task.title}</span>
                {task.dueDate && task.dueDate < today && (
                  <span className="text-xs text-destructive shrink-0">overdue</span>
                )}
                {task.priority === 'urgent' && (
                  <span className="text-xs text-destructive font-medium shrink-0">urgent</span>
                )}
                {task.priority === 'high' && (
                  <span className="text-xs text-orange-600 dark:text-orange-400 font-medium shrink-0">high</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 3: Quick Stats */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Quick Stats
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {statCards.map((stat) => (
            <button
              key={stat.label}
              onClick={() => navigate(stat.path)}
              className="flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-left hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-1.5">
                {stat.icon}
                <span className="text-xs text-muted-foreground">{stat.label}</span>
              </div>
              <span className="text-sm font-medium capitalize truncate">{stat.value}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Section 4: Recent Activity */}
      {recentActivity.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Recent Activity
          </h2>
          <div className="space-y-0.5">
            {recentActivity.map((entity) => (
              <div
                key={entity.id}
                className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/50 transition-colors"
              >
                <Clock className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
                <span className="text-sm flex-1 truncate">{entity.title}</span>
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
                    TYPE_COLORS[entity.type] ?? 'bg-muted text-muted-foreground'
                  }`}
                >
                  {entity.type}
                </span>
                <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                  {relativeTime(entity.updatedAt)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Section 5: Inbox (conditional) */}
      {inboxItems.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Inbox
          </h2>
          <button
            onClick={() => navigate('/notes')}
            className="w-full flex items-center gap-3 rounded-lg border border-dashed border-primary/30 p-4 hover:bg-muted/50 transition-colors text-left"
          >
            <Inbox className="h-5 w-5 text-primary shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                You have {inboxItems.length} {inboxItems.length === 1 ? 'item' : 'items'} to
                process
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Tap to review your inbox
              </p>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </button>
        </section>
      )}
    </div>
  )
}
