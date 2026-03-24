import type { Entity } from '@/core/types'

export const MS_PER_DAY = 86_400_000
export const MS_PER_WEEK = 7 * MS_PER_DAY

/** Monthly spending aggregated by budget category */
export interface MonthlySpending {
  spentByCategory: Record<string, number>
  daysPassed: number
  daysLeft: number
  daysInMonth: number
}

export function getMonthlySpending(entities: Entity[], today: string): MonthlySpending {
  const monthStart = today.slice(0, 7) + '-01'
  const todayDate = new Date(today)
  const daysInMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate()
  const daysPassed = todayDate.getDate()
  const daysLeft = daysInMonth - daysPassed

  const transactions = entities.filter(
    (e) =>
      e.type === 'transaction' &&
      e.metadata?.txType === 'expense' &&
      ((e.metadata?.date as string) || '') >= monthStart,
  )

  const spentByCategory: Record<string, number> = {}
  for (const tx of transactions) {
    const cat = (tx.metadata?.category as string) || 'other'
    spentByCategory[cat] = (spentByCategory[cat] || 0) + ((tx.metadata?.amount as number) || 0)
  }

  return { spentByCategory, daysPassed, daysLeft, daysInMonth }
}

/** 7-day vs previous 7-day sleep averages */
export interface SleepTrend {
  recentAvg: number
  olderAvg: number
  drop: number
  entries: number
}

export function getSleepTrend(entities: Entity[], now: number): SleepTrend | null {
  const sleepEntries = entities
    .filter((e) => e.type === 'sleep-mood' && typeof e.metadata?.sleepHours === 'number')
    .sort((a, b) =>
      ((b.metadata?.date as string) || '').localeCompare((a.metadata?.date as string) || ''),
    )

  if (sleepEntries.length < 5) return null

  const recentCutoff = new Date(now - 7 * MS_PER_DAY).toISOString().split('T')[0]
  const olderCutoff = new Date(now - 14 * MS_PER_DAY).toISOString().split('T')[0]

  const recent = sleepEntries.filter((e) => ((e.metadata?.date as string) || '') >= recentCutoff)
  const older = sleepEntries.filter((e) => {
    const d = (e.metadata?.date as string) || ''
    return d >= olderCutoff && d < recentCutoff
  })

  if (recent.length === 0 || older.length === 0) return null

  const recentAvg = recent.reduce((s, e) => s + (e.metadata?.sleepHours as number), 0) / recent.length
  const olderAvg = older.reduce((s, e) => s + (e.metadata?.sleepHours as number), 0) / older.length

  return { recentAvg, olderAvg, drop: olderAvg - recentAvg, entries: sleepEntries.length }
}

/** Week-over-week task velocity for a project */
export function getProjectVelocity(
  entities: Entity[],
  projectId: string,
  now: number,
): { thisWeek: number; lastWeek: number } {
  const thisWeekStart = new Date(now - MS_PER_WEEK).toISOString()
  const lastWeekStart = new Date(now - 2 * MS_PER_WEEK).toISOString()

  const tasks = entities.filter(
    (e) => e.type === 'task' && e.metadata?.projectId === projectId,
  )

  const thisWeek = tasks.filter(
    (t) => t.status === 'done' && (t.updatedAt ?? t.createdAt) >= thisWeekStart,
  ).length

  const lastWeek = tasks.filter(
    (t) =>
      t.status === 'done' &&
      (t.updatedAt ?? t.createdAt) >= lastWeekStart &&
      (t.updatedAt ?? t.createdAt) < thisWeekStart,
  ).length

  return { thisWeek, lastWeek }
}
