import { useMemo } from 'react'
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
  CheckSquare,
  Repeat,
  Moon,
  Dumbbell,
  Flame,
  Brain,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { useEntities, useTrackers } from '@/core/hooks'

import { loadHealthProfile, calcBMI, getBMICategory } from '@/lib/health-calc'
import type { Entity, Tracker } from '@/core/types'

/* ─── Date helpers ─── */

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)) // Monday start
  d.setHours(0, 0, 0, 0)
  return d
}

function getLast90Days(): string[] {
  const days: string[] = []
  const now = new Date()
  for (let i = 89; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().split('T')[0])
  }
  return days
}

/* ─── Trend arrow component ─── */

function TrendIndicator({ current, previous, suffix = '' }: {
  current: number
  previous: number
  suffix?: string
}) {
  const diff = current - previous
  const improving = diff > 0
  const declining = diff < 0
  const stable = diff === 0

  if (stable) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="h-3 w-3" />
        No change
      </span>
    )
  }

  const sign = diff > 0 ? '+' : ''
  const displayDiff = `${sign}${diff}${suffix}`

  return (
    <span className={`flex items-center gap-1 text-xs font-medium ${
      improving
        ? 'text-green-600 dark:text-green-400'
        : declining
          ? 'text-red-500 dark:text-red-400'
          : 'text-muted-foreground'
    }`}>
      {improving ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {displayDiff} vs last week
    </span>
  )
}

/* ─── Life Score label ─── */

function getScoreLabel(score: number): { label: string; color: string } {
  if (score >= 90) return { label: 'Excellent', color: 'text-green-600 dark:text-green-400' }
  if (score >= 75) return { label: 'Great', color: 'text-green-600 dark:text-green-400' }
  if (score >= 60) return { label: 'Good', color: 'text-blue-600 dark:text-blue-400' }
  if (score >= 40) return { label: 'Fair', color: 'text-amber-600 dark:text-amber-400' }
  return { label: 'Needs work', color: 'text-red-500 dark:text-red-400' }
}

/* ─── Metric computation helpers ─── */

function computeCheckInRate(
  items: Entity[],
  trackers: Tracker[],
  from: Date,
  to: Date,
): number {
  if (items.length === 0) return 0
  const fromISO = from.toISOString()
  const toISO = to.toISOString()
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000))
  const totalSlots = items.length * days

  let checkIns = 0
  const itemIds = new Set(items.map((i) => i.id))
  for (const t of trackers) {
    if (itemIds.has(t.entityId) && t.timestamp >= fromISO && t.timestamp < toISO) {
      checkIns++
    }
  }

  return Math.round((checkIns / totalSlots) * 100)
}

function computeAvgSleep(
  sleepEntities: Entity[],
  fromISO: string,
  toISO?: string,
): number {
  const filtered = sleepEntities.filter((e) => {
    const date = e.dueDate ?? e.createdAt
    return date >= fromISO && (toISO ? date < toISO : true)
  })
  if (filtered.length === 0) return 0
  const total = filtered.reduce((sum, e) => {
    const hours = typeof e.metadata.sleepHours === 'number' ? (e.metadata.sleepHours as number) : 0
    return sum + hours
  }, 0)
  return Math.round((total / filtered.length) * 10) / 10
}

function computeActiveMinutes(
  workouts: Entity[],
  fromISO: string,
  toISO?: string,
): number {
  return workouts
    .filter((w) => {
      const date = w.dueDate ?? w.createdAt
      return date >= fromISO && (toISO ? date < toISO : true)
    })
    .reduce((sum, w) => {
      const dur = typeof w.metadata.duration === 'number' ? (w.metadata.duration as number) : 0
      return sum + dur
    }, 0)
}

/* ─── Main page ─── */

export function DashboardPage() {
  const { items: allEntities } = useEntities()
  const { items: allTrackers } = useTrackers()


  const now = useMemo(() => new Date(), [])
  const thisWeekStart = useMemo(() => startOfWeek(now), [now])
  const lastWeekStart = useMemo(() => {
    const d = new Date(thisWeekStart)
    d.setDate(d.getDate() - 7)
    return d
  }, [thisWeekStart])
  const thisWeekISO = useMemo(() => thisWeekStart.toISOString(), [thisWeekStart])
  const lastWeekISO = useMemo(() => lastWeekStart.toISOString(), [lastWeekStart])

  // ─── Filtered entities ───

  const tasks = useMemo(
    () => allEntities.filter((e) => e.type === 'task'),
    [allEntities],
  )

  const habits = useMemo(
    () => allEntities.filter((e) => e.type === 'habit' && e.status === 'active' && !e.metadata.isProtocol),
    [allEntities],
  )

  const protocols = useMemo(
    () => allEntities.filter((e) => e.type === 'habit' && e.status === 'active' && e.metadata.isProtocol === true),
    [allEntities],
  )

  const goals = useMemo(
    () => allEntities.filter((e) => e.type === 'goal' && e.status === 'active'),
    [allEntities],
  )

  const sleepEntities = useMemo(
    () => allEntities.filter((e) => e.type === 'sleep-mood'),
    [allEntities],
  )

  const workouts = useMemo(
    () => allEntities.filter((e) => e.type === 'workout'),
    [allEntities],
  )

  // ─── Tasks done this week vs last ───

  const tasksThisWeek = useMemo(
    () => tasks.filter((t) => t.status === 'completed' && t.updatedAt >= thisWeekISO).length,
    [tasks, thisWeekISO],
  )

  const tasksLastWeek = useMemo(
    () => tasks.filter((t) => t.status === 'completed' && t.updatedAt >= lastWeekISO && t.updatedAt < thisWeekISO).length,
    [tasks, lastWeekISO, thisWeekISO],
  )

  // ─── Habit / protocol check-in rates ───

  const habitRate = useMemo(
    () => computeCheckInRate(habits, allTrackers, thisWeekStart, now),
    [habits, allTrackers, thisWeekStart, now],
  )

  const habitRateLast = useMemo(
    () => computeCheckInRate(habits, allTrackers, lastWeekStart, thisWeekStart),
    [habits, allTrackers, lastWeekStart, thisWeekStart],
  )

  const protocolRate = useMemo(
    () => computeCheckInRate(protocols, allTrackers, thisWeekStart, now),
    [protocols, allTrackers, thisWeekStart, now],
  )

  const protocolRateLast = useMemo(
    () => computeCheckInRate(protocols, allTrackers, lastWeekStart, thisWeekStart),
    [protocols, allTrackers, lastWeekStart, thisWeekStart],
  )

  // ─── Average sleep ───

  const avgSleepThisWeek = useMemo(
    () => computeAvgSleep(sleepEntities, thisWeekISO),
    [sleepEntities, thisWeekISO],
  )

  const avgSleepLastWeek = useMemo(
    () => computeAvgSleep(sleepEntities, lastWeekISO, thisWeekISO),
    [sleepEntities, lastWeekISO, thisWeekISO],
  )

  // ─── Active minutes ───

  const activeMinThisWeek = useMemo(
    () => computeActiveMinutes(workouts, thisWeekISO),
    [workouts, thisWeekISO],
  )

  const activeMinLastWeek = useMemo(
    () => computeActiveMinutes(workouts, lastWeekISO, thisWeekISO),
    [workouts, lastWeekISO, thisWeekISO],
  )

  // ─── Goal progress average ───

  const goalProgressAvg = useMemo(() => {
    if (goals.length === 0) return 0
    const total = goals.reduce((sum, g) => {
      const p = typeof g.metadata.progress === 'number' ? (g.metadata.progress as number) : 0
      return sum + p
    }, 0)
    return Math.round(total / goals.length)
  }, [goals])

  // ─── Life Score (0-100) ───

  const lifeScore = useMemo(() => {
    const daysSoFar = Math.max(1, Math.ceil((now.getTime() - thisWeekStart.getTime()) / 86400000))

    // Task completion rate (25%) — compare against last week or a baseline of 5
    const taskBaseline = Math.max(tasksLastWeek, 5)
    const taskScore = Math.min(tasksThisWeek / taskBaseline, 1) * 100

    // Habit rate (30%)
    const habitScore = habitRate

    // Goal progress (20%)
    const goalScore = goalProgressAvg

    // Sleep (15%) — score based on proximity to 7h target
    const sleepScore = avgSleepThisWeek > 0
      ? Math.min(avgSleepThisWeek / 7, 1) * 100
      : 50

    // Active minutes (10%) — 150 min/week target, pro-rated by days elapsed
    const targetMinutes = (150 / 7) * daysSoFar
    const activeScore = targetMinutes > 0
      ? Math.min(activeMinThisWeek / targetMinutes, 1) * 100
      : 50

    return Math.round(
      taskScore * 0.25 +
      habitScore * 0.30 +
      goalScore * 0.20 +
      sleepScore * 0.15 +
      activeScore * 0.10,
    )
  }, [tasksThisWeek, tasksLastWeek, habitRate, goalProgressAvg, avgSleepThisWeek, activeMinThisWeek, now, thisWeekStart])

  const scoreInfo = getScoreLabel(lifeScore)

  // ─── Protocol streaks ───

  const protocolStreaks = useMemo(
    () => protocols
      .map((p) => ({
        id: p.id,
        name: p.title,
        streak: typeof p.metadata.streak === 'number' ? (p.metadata.streak as number) : 0,
      }))
      .sort((a, b) => b.streak - a.streak),
    [protocols],
  )

  // ─── Combined heatmap ───

  const heatmapDays = useMemo(() => getLast90Days(), [])

  const heatmapData = useMemo(() => {
    const allHabitIds = new Set([
      ...habits.map((h) => h.id),
      ...protocols.map((p) => p.id),
    ])
    const countByDay = new Map<string, number>()
    for (const t of allTrackers) {
      if (!allHabitIds.has(t.entityId)) continue
      const day = t.timestamp.split('T')[0]
      countByDay.set(day, (countByDay.get(day) ?? 0) + 1)
    }
    return countByDay
  }, [habits, protocols, allTrackers])

  const maxHeatmapValue = useMemo(() => {
    let max = 1
    for (const v of heatmapData.values()) {
      if (v > max) max = v
    }
    return max
  }, [heatmapData])

  const totalCheckIns = useMemo(
    () => Array.from(heatmapData.values()).reduce((a, b) => a + b, 0),
    [heatmapData],
  )

  // ─── Health data for AI summary ───

  const healthProfile = useMemo(() => loadHealthProfile(), [])

  const latestWeight = useMemo(() => {
    const metrics = allEntities
      .filter((e) => e.type === 'body-metric' && typeof e.metadata.weight === 'number')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return metrics.length > 0 ? (metrics[0].metadata.weight as number) : null
  }, [allEntities])

  const bmiInfo = useMemo(() => {
    if (!healthProfile || !latestWeight) return null
    const bmi = calcBMI(latestWeight, healthProfile.heightCm)
    return { bmi: Math.round(bmi * 10) / 10, category: getBMICategory(bmi) }
  }, [healthProfile, latestWeight])

  // ─── AI Context Summary text ───

  const aiSummary = useMemo(() => {
    const parts: string[] = []
    const taskDiff = tasksThisWeek - tasksLastWeek
    const taskDiffStr = tasksLastWeek > 0 ? ` (${taskDiff >= 0 ? '+' : ''}${taskDiff} vs last week)` : ''
    parts.push(`You completed ${tasksThisWeek} task${tasksThisWeek !== 1 ? 's' : ''} this week${taskDiffStr}.`)
    parts.push(`Habit rate: ${habitRate}%.`)
    if (protocolRate > 0) parts.push(`Protocol rate: ${protocolRate}%.`)
    if (avgSleepThisWeek > 0) parts.push(`Sleeping ${avgSleepThisWeek}h avg.`)
    if (activeMinThisWeek > 0) parts.push(`${activeMinThisWeek} active minutes this week.`)
    if (bmiInfo) parts.push(`BMI ${bmiInfo.bmi} (${bmiInfo.category}).`)
    if (goalProgressAvg > 0) parts.push(`Goal progress avg: ${goalProgressAvg}%.`)
    const topStreak = protocolStreaks[0]
    if (topStreak && topStreak.streak > 0) {
      parts.push(`Top protocol streak: ${topStreak.name} (${topStreak.streak} days).`)
    }
    parts.push(`Life score: ${lifeScore}/100.`)
    return parts.join(' ')
  }, [tasksThisWeek, tasksLastWeek, habitRate, protocolRate, avgSleepThisWeek, activeMinThisWeek, bmiInfo, goalProgressAvg, protocolStreaks, lifeScore])

  // ─── Trend cards ───

  const trendCards = [
    { label: 'Tasks Done', icon: CheckSquare, value: tasksThisWeek, previous: tasksLastWeek, suffix: '' },
    { label: 'Habit Rate', icon: Repeat, value: habitRate, previous: habitRateLast, suffix: '%' },
    { label: 'Protocol Rate', icon: Flame, value: protocolRate, previous: protocolRateLast, suffix: '%' },
    { label: 'Avg Sleep', icon: Moon, value: avgSleepThisWeek, previous: avgSleepLastWeek, suffix: 'h' },
    { label: 'Active Min', icon: Dumbbell, value: activeMinThisWeek, previous: activeMinLastWeek, suffix: '' },
    { label: 'Goal Progress', icon: Target, value: goalProgressAvg, previous: 0, suffix: '%' },
  ]

  // ─── Render ───

  return (
    <div className="h-[calc(100vh-5rem)] flex flex-col overflow-y-auto scrollbar-thin">
      {/* Header */}
      <header className="shrink-0 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-primary/70" />
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Weekly trends and life metrics
        </p>
      </header>

      <div className="space-y-6 pb-8">
        {/* ── Section 1: Life Score ── */}
        <Card className="p-6">
          <div className="flex items-center gap-6">
            <div className="relative shrink-0">
              <svg className="h-24 w-24 -rotate-90" viewBox="0 0 100 100">
                <circle
                  cx="50" cy="50" r="42"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-muted/40"
                />
                <circle
                  cx="50" cy="50" r="42"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={`${lifeScore * 2.64} 264`}
                  className={scoreInfo.color}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-2xl font-bold tabular-nums">{lifeScore}</span>
              </div>
            </div>
            <div>
              <h2 className="text-lg font-semibold">Life Score</h2>
              <Badge variant="secondary" className={`mt-1 ${scoreInfo.color}`}>
                {scoreInfo.label}
              </Badge>
              <p className="text-xs text-muted-foreground mt-2 max-w-sm">
                Composite of tasks (25%), habits (30%), goals (20%), sleep (15%), and activity (10%) this week.
              </p>
            </div>
          </div>
        </Card>

        {/* ── Section 2: Weekly Trends ── */}
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-3">
            Weekly Trends
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {trendCards.map((card) => {
              const Icon = card.icon
              return (
                <Card key={card.label} className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="h-4 w-4 text-muted-foreground/60" />
                    <span className="text-xs text-muted-foreground font-medium">{card.label}</span>
                  </div>
                  <p className="text-2xl font-bold tabular-nums">
                    {card.value}{card.suffix}
                  </p>
                  <div className="mt-1.5">
                    <TrendIndicator
                      current={card.value}
                      previous={card.previous}
                      suffix={card.suffix}
                    />
                  </div>
                </Card>
              )
            })}
          </div>
        </div>

        {/* ── Section 3: Protocol Streaks ── */}
        {protocolStreaks.length > 0 && (
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-3">
              Protocol Streaks
            </h2>
            <Card className="p-4 space-y-3">
              {protocolStreaks.map((p) => (
                <div key={p.id} className="flex items-center gap-3">
                  <span className="text-sm w-36 shrink-0 truncate">{p.name}</span>
                  <div className="flex-1">
                    <Progress value={Math.min((p.streak / 30) * 100, 100)} className="h-2" />
                  </div>
                  <span className="text-sm font-medium tabular-nums w-12 text-right">
                    {p.streak}d
                  </span>
                </div>
              ))}
            </Card>
          </div>
        )}

        {/* ── Section 4: Combined Heatmap (90 days) ── */}
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-3">
            Activity Heatmap — Last 90 Days
          </h2>
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">
                Habits + Protocols completed per day
              </span>
              <span className="text-xs font-medium tabular-nums">
                {totalCheckIns} total check-ins
              </span>
            </div>
            <div className="flex flex-wrap gap-[2px]">
              {heatmapDays.map((day) => {
                const count = heatmapData.get(day) ?? 0
                const intensity = count === 0 ? 0 : Math.ceil((count / maxHeatmapValue) * 4)
                return (
                  <div
                    key={day}
                    title={`${day}: ${count} check-in${count !== 1 ? 's' : ''}`}
                    className={`w-2.5 h-2.5 rounded-sm ${
                      intensity === 0 ? 'bg-muted' :
                      intensity === 1 ? 'bg-green-200 dark:bg-green-900' :
                      intensity === 2 ? 'bg-green-400 dark:bg-green-700' :
                      intensity === 3 ? 'bg-green-500 dark:bg-green-500' :
                      'bg-green-600 dark:bg-green-400'
                    }`}
                  />
                )
              })}
            </div>
            <div className="flex items-center gap-1 mt-2 justify-end">
              <span className="text-[10px] text-muted-foreground mr-1">Less</span>
              <div className="w-2.5 h-2.5 rounded-sm bg-muted" />
              <div className="w-2.5 h-2.5 rounded-sm bg-green-200 dark:bg-green-900" />
              <div className="w-2.5 h-2.5 rounded-sm bg-green-400 dark:bg-green-700" />
              <div className="w-2.5 h-2.5 rounded-sm bg-green-500 dark:bg-green-500" />
              <div className="w-2.5 h-2.5 rounded-sm bg-green-600 dark:bg-green-400" />
              <span className="text-[10px] text-muted-foreground ml-1">More</span>
            </div>
          </Card>
        </div>

        {/* ── Section 5: AI Context Summary ── */}
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-3">
            <Brain className="h-3 w-3 inline mr-1.5 -mt-px" />
            AI Context Summary
          </h2>
          <Card className="p-4 bg-muted/30 border-dashed">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {aiSummary}
            </p>
            <p className="text-[10px] text-muted-foreground/50 mt-2">
              This is a preview of the data context sent to the AI assistant.
            </p>
          </Card>
        </div>
      </div>
    </div>
  )
}
