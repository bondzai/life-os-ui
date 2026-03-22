/**
 * Scoreboard hook — aggregates key performance metrics across tasks,
 * habits, focus, sleep, goals, projects, and budgets into a single object.
 * Consumed by AI context builders and future agents. No UI.
 */

import { useMemo } from 'react'
import { useEntities, useTrackers } from '@/core/hooks'
import { calcFocusStats } from '@/lib/focus-stats'
import type { Entity } from '@/core/types'

// ── Public types ──

export type Trend = 'up' | 'down' | 'stable'

export interface Scoreboard {
  taskVelocity: {
    thisWeek: number
    lastWeek: number
    avg4Week: number
    trend: Trend
  }
  focusHours: {
    thisWeek: number
    trend: Trend
  }
  habitRate: {
    /** 0-100 adherence percentage */
    current: number
    trend: Trend
  }
  sleepAvg: {
    /** Average sleep hours this week */
    current: number
    trend: Trend
  }
  goalProgress: Array<{
    goal: Entity
    /** 0-100 percentage */
    progress: number
    /** Tasks done this week for this goal */
    velocity: number
    risk: 'on-track' | 'at-risk' | 'will-miss'
  }>
  projectVelocity: Array<{
    project: Entity
    thisWeek: number
    lastWeek: number
    trend: Trend
  }>
  /** 0-100 overall budget adherence */
  budgetHealth: number
  streaks: Array<{
    habit: Entity
    /** Consecutive days with a check-in */
    streak: number
  }>
}

// ── Helpers ──

const DAY_MS = 86_400_000

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  d.setHours(0, 0, 0, 0)
  return d
}

function trend(current: number, previous: number): Trend {
  if (current > previous) return 'up'
  if (current < previous) return 'down'
  return 'stable'
}

function computeCheckInRate(
  habitIds: Set<string>,
  trackerTimestamps: Map<string, string[]>,
  fromISO: string,
  toISO: string,
  days: number,
): number {
  if (habitIds.size === 0) return 0
  const totalSlots = habitIds.size * Math.max(1, days)
  let checkIns = 0
  for (const id of habitIds) {
    const timestamps = trackerTimestamps.get(id)
    if (!timestamps) continue
    for (const ts of timestamps) {
      if (ts >= fromISO && ts < toISO) checkIns++
    }
  }
  return Math.round((checkIns / totalSlots) * 100)
}

// ── Hook ──

export function useScoreboard(): Scoreboard {
  const { items: entities } = useEntities()
  const { items: trackers } = useTrackers()

  return useMemo(() => {
    const now = new Date()
    const thisWeekStart = startOfWeek(now)
    const lastWeekStart = new Date(thisWeekStart)
    lastWeekStart.setDate(lastWeekStart.getDate() - 7)
    const twoWeeksAgoStart = new Date(lastWeekStart)
    twoWeeksAgoStart.setDate(twoWeeksAgoStart.getDate() - 7)
    const fourWeeksAgoStart = new Date(thisWeekStart)
    fourWeeksAgoStart.setDate(fourWeeksAgoStart.getDate() - 28)

    const thisWeekISO = thisWeekStart.toISOString()
    const lastWeekISO = lastWeekStart.toISOString()
    const fourWeeksAgoISO = fourWeeksAgoStart.toISOString()

    // ── Categorise entities ──
    const tasks: Entity[] = []
    const habits: Entity[] = []
    const goals: Entity[] = []
    const projects: Entity[] = []
    const sleepEntities: Entity[] = []
    const budgets: Entity[] = []
    const transactions: Entity[] = []

    for (const e of entities) {
      switch (e.type) {
        case 'task':
          tasks.push(e)
          break
        case 'habit':
          if (e.status === 'todo' && !e.metadata?.isProtocol) habits.push(e)
          break
        case 'goal':
          if (e.status !== 'archived') goals.push(e)
          break
        case 'project':
          if (e.status !== 'archived') projects.push(e)
          break
        case 'sleep-mood':
          sleepEntities.push(e)
          break
        case 'budget':
          if (e.status !== 'archived') budgets.push(e)
          break
        case 'transaction':
          transactions.push(e)
          break
      }
    }

    // ── Task velocity ──
    const doneTasks = tasks.filter((t) => t.status === 'done')
    const tasksThisWeek = doneTasks.filter((t) => t.updatedAt >= thisWeekISO).length
    const tasksLastWeek = doneTasks.filter(
      (t) => t.updatedAt >= lastWeekISO && t.updatedAt < thisWeekISO,
    ).length

    // 4-week average
    const tasks4Weeks = doneTasks.filter((t) => t.updatedAt >= fourWeeksAgoISO).length
    const avg4Week = Math.round((tasks4Weeks / 4) * 10) / 10

    // ── Focus hours ──
    const entityTitles = new Map<string, string>()
    for (const e of entities) entityTitles.set(e.id, e.title)
    const focusStats = calcFocusStats(trackers, entityTitles)
    const focusHoursThisWeek = Math.round((focusStats.thisWeekMinutes / 60) * 10) / 10
    const focusHoursLastWeek = Math.round((focusStats.lastWeekMinutes / 60) * 10) / 10

    // ── Habit rate ──
    const habitIds = new Set(habits.map((h) => h.id))
    const trackersByEntity = new Map<string, string[]>()
    for (const t of trackers) {
      const list = trackersByEntity.get(t.entityId)
      if (list) {
        list.push(t.timestamp)
      } else {
        trackersByEntity.set(t.entityId, [t.timestamp])
      }
    }

    const daysSoFar = Math.max(1, Math.ceil((now.getTime() - thisWeekStart.getTime()) / DAY_MS))
    const daysLastWeek = 7
    const habitRateCurrent = computeCheckInRate(habitIds, trackersByEntity, thisWeekISO, now.toISOString(), daysSoFar)
    const habitRateLast = computeCheckInRate(habitIds, trackersByEntity, lastWeekISO, thisWeekISO, daysLastWeek)

    // ── Sleep average ──
    const sleepThisWeek = sleepEntities.filter((e) => {
      const d = e.dueDate ?? e.createdAt
      return d >= thisWeekISO
    })
    const sleepLastWeek = sleepEntities.filter((e) => {
      const d = e.dueDate ?? e.createdAt
      return d >= lastWeekISO && d < thisWeekISO
    })

    const avgSleep = (entries: Entity[]): number => {
      if (entries.length === 0) return 0
      const total = entries.reduce(
        (sum, e) => sum + (typeof e.metadata?.sleepHours === 'number' ? (e.metadata.sleepHours as number) : 0),
        0,
      )
      return Math.round((total / entries.length) * 10) / 10
    }

    const sleepCurrent = avgSleep(sleepThisWeek)
    const sleepLast = avgSleep(sleepLastWeek)

    // ── Goal progress ──
    const goalProgress = goals
      .filter((g) => g.status !== 'done')
      .map((goal) => {
        const progress = typeof goal.metadata?.progress === 'number' ? (goal.metadata.progress as number) : 0
        const goalTasks = tasks.filter((t) => t.metadata?.goalId === goal.id)
        const velocity = goalTasks.filter((t) => t.status === 'done' && t.updatedAt >= thisWeekISO).length

        let risk: 'on-track' | 'at-risk' | 'will-miss' = 'on-track'
        if (goal.dueDate) {
          const remaining = goalTasks.filter((t) => t.status !== 'done' && t.status !== 'archived').length
          const weeksLeft = Math.max(1, (new Date(goal.dueDate).getTime() - now.getTime()) / (7 * DAY_MS))
          const avgVelocity = velocity > 0 ? velocity : avg4Week / Math.max(goals.length, 1)
          const projectedWeeks = avgVelocity > 0 ? remaining / avgVelocity : Infinity
          if (projectedWeeks > weeksLeft) risk = 'will-miss'
          else if (projectedWeeks > weeksLeft * 0.8) risk = 'at-risk'
        }

        return { goal, progress, velocity, risk }
      })

    // ── Project velocity ──
    const projectVelocity = projects
      .filter((p) => p.status !== 'done')
      .map((project) => {
        const projTasks = tasks.filter((t) => t.metadata?.projectId === project.id && t.status === 'done')
        const tw = projTasks.filter((t) => t.updatedAt >= thisWeekISO).length
        const lw = projTasks.filter((t) => t.updatedAt >= lastWeekISO && t.updatedAt < thisWeekISO).length
        return {
          project,
          thisWeek: tw,
          lastWeek: lw,
          trend: trend(tw, lw),
        }
      })

    // ── Budget health ──
    let budgetHealth = 100
    if (budgets.length > 0) {
      const now_month = now.toISOString().slice(0, 7) // YYYY-MM
      let totalLimit = 0
      let totalSpent = 0

      for (const b of budgets) {
        const limit = typeof b.metadata?.limit === 'number' ? (b.metadata.limit as number) : 0
        if (limit <= 0) continue
        totalLimit += limit

        // Sum transactions for this budget's category in current month
        const category = (b.metadata?.category as string | undefined) ?? b.title.toLowerCase()
        const spent = transactions
          .filter((t) => {
            const txDate = t.dueDate ?? t.createdAt
            return txDate.startsWith(now_month) && (
              t.metadata?.budgetId === b.id ||
              (t.metadata?.category as string | undefined)?.toLowerCase() === category.toLowerCase()
            )
          })
          .reduce((sum, t) => sum + (typeof t.metadata?.amount === 'number' ? (t.metadata.amount as number) : 0), 0)

        totalSpent += spent
      }

      budgetHealth = totalLimit > 0
        ? Math.max(0, Math.min(100, Math.round((1 - totalSpent / totalLimit) * 100)))
        : 100
    }

    // ── Habit streaks ──
    const streaks = habits.map((habit) => {
      const timestamps = trackersByEntity.get(habit.id) ?? []
      const dateSet = new Set(timestamps.map((ts) => ts.split('T')[0]))

      let streak = 0
      for (let i = 0; i < 365; i++) {
        const d = new Date(now)
        d.setDate(d.getDate() - i)
        const ds = d.toISOString().split('T')[0]
        if (dateSet.has(ds)) {
          streak++
        } else if (i > 0) {
          // Allow today to be missing (day not over yet)
          break
        }
      }

      return { habit, streak }
    }).filter((s) => s.streak > 0)
      .sort((a, b) => b.streak - a.streak)

    return {
      taskVelocity: {
        thisWeek: tasksThisWeek,
        lastWeek: tasksLastWeek,
        avg4Week,
        trend: trend(tasksThisWeek, tasksLastWeek),
      },
      focusHours: {
        thisWeek: focusHoursThisWeek,
        trend: trend(focusHoursThisWeek, focusHoursLastWeek),
      },
      habitRate: {
        current: habitRateCurrent,
        trend: trend(habitRateCurrent, habitRateLast),
      },
      sleepAvg: {
        current: sleepCurrent,
        trend: trend(sleepCurrent, sleepLast),
      },
      goalProgress,
      projectVelocity,
      budgetHealth,
      streaks,
    }
  }, [entities, trackers])
}
