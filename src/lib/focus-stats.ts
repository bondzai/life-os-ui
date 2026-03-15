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

  // Today
  let todayMinutes = 0
  let todaySessions = 0
  for (const t of focusTrackers) {
    if (t.timestamp.startsWith(todayStr)) {
      todayMinutes += t.value
      todaySessions++
    }
  }

  // Weekly chart (7 days Mon-Sun)
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const weekDays: DailyFocus[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(thisWeekStart)
    d.setDate(d.getDate() + i)
    const dateStr = d.toISOString().split('T')[0]
    let minutes = 0
    let sessions = 0
    for (const t of focusTrackers) {
      if (t.timestamp.startsWith(dateStr)) {
        minutes += t.value
        sessions++
      }
    }
    weekDays.push({ date: dateStr, label: weekdays[i], minutes, sessions })
  }

  // This week vs last week
  let thisWeekMinutes = 0
  let lastWeekMinutes = 0
  for (const t of focusTrackers) {
    const d = new Date(t.timestamp)
    if (d >= thisWeekStart) thisWeekMinutes += t.value
    else if (d >= lastWeekStart && d < thisWeekStart) lastWeekMinutes += t.value
  }

  // Top tasks by focus time
  const taskMinutes = new Map<string, number>()
  for (const t of focusTrackers) {
    taskMinutes.set(t.entityId, (taskMinutes.get(t.entityId) ?? 0) + t.value)
  }
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
  const dateSet = new Set<string>()
  for (const t of focusTrackers) {
    dateSet.add(t.timestamp.split('T')[0])
  }
  for (let i = 0; i < 365; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    if (dateSet.has(dateStr)) {
      streak++
    } else {
      // Skip today if no sessions yet (don't break streak)
      if (i === 0) continue
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
