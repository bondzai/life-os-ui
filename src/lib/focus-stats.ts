/**
 * Pure functions for calculating deep work statistics from trackers.
 * Trackers with unit='focus-min' are focus session records.
 */

import type { Tracker } from '@/core/types'

interface DailyFocus {
  date: string    // YYYY-MM-DD
  label: string   // Mon, Tue, etc.
  minutes: number
  sessions: number
}

interface TopTask {
  entityId: string
  title: string
  minutes: number
}

export interface FocusStats {
  todayMinutes: number
  todaySessions: number
  weekDays: DailyFocus[]
  thisWeekMinutes: number
  lastWeekMinutes: number
  weekDiff: number
  topTasks: TopTask[]
  streak: number
}

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  d.setHours(0, 0, 0, 0)
  return d
}

export function calcFocusStats(
  trackers: Tracker[],
  entityTitles: Map<string, string>,
): FocusStats {
  const focusTrackers = trackers.filter((t) => t.unit === 'focus-min')
  const todayStr = new Date().toISOString().split('T')[0]
  const now = new Date()
  const thisWeekStart = startOfWeek(now)
  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(lastWeekStart.getDate() - 7)

  // Pre-compute week day date strings
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const weekDayDates: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(thisWeekStart)
    d.setDate(d.getDate() + i)
    weekDayDates.push(d.toISOString().split('T')[0])
  }

  // Single pass through all focus trackers
  let todayMinutes = 0
  let todaySessions = 0
  let thisWeekMinutes = 0
  let lastWeekMinutes = 0
  const dayMinutes = new Map<string, number>()
  const daySessions = new Map<string, number>()
  const taskMinutes = new Map<string, number>()
  const dateSet = new Set<string>()

  for (const t of focusTrackers) {
    const dateStr = t.timestamp.split('T')[0]
    const ts = new Date(t.timestamp)

    // Today
    if (dateStr === todayStr) {
      todayMinutes += t.value
      todaySessions++
    }

    // This week / last week
    if (ts >= thisWeekStart) thisWeekMinutes += t.value
    else if (ts >= lastWeekStart) lastWeekMinutes += t.value

    // Daily aggregates (for week chart)
    dayMinutes.set(dateStr, (dayMinutes.get(dateStr) ?? 0) + t.value)
    daySessions.set(dateStr, (daySessions.get(dateStr) ?? 0) + 1)

    // Task aggregates
    taskMinutes.set(t.entityId, (taskMinutes.get(t.entityId) ?? 0) + t.value)

    // Date set for streak
    dateSet.add(dateStr)
  }

  // Build week days from pre-indexed data
  const weekDays: DailyFocus[] = weekDayDates.map((date, i) => ({
    date,
    label: weekdays[i],
    minutes: dayMinutes.get(date) ?? 0,
    sessions: daySessions.get(date) ?? 0,
  }))

  // Top tasks by focus time
  const topTasks = Array.from(taskMinutes.entries())
    .map(([entityId, minutes]) => ({
      entityId,
      title: entityTitles.get(entityId) || 'Unknown',
      minutes,
    }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 5)

  // Streak: consecutive days with at least 1 session (counting back from today)
  let streak = 0
  for (let i = 0; i < 365; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const ds = d.toISOString().split('T')[0]
    if (dateSet.has(ds)) {
      streak++
    } else if (i > 0) {
      break
    }
  }

  return {
    todayMinutes,
    todaySessions,
    weekDays,
    thisWeekMinutes,
    lastWeekMinutes,
    weekDiff: thisWeekMinutes - lastWeekMinutes,
    topTasks,
    streak,
  }
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}
