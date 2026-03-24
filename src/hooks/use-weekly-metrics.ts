import { useMemo } from 'react'
import { useEntities, useTrackers } from '@/core/hooks'
import { getWeekStart } from '@/pages/review/review-helpers'

export interface HabitSummary {
  habit: import('@/core/types').Entity
  checkIns: number
  streak: number
}

export interface WeeklyMetrics {
  weekStart: string
  completed: import('@/core/types').Entity[]
  habitSummaries: HabitSummary[]
  inboxCount: number
}

export function useWeeklyMetrics(): WeeklyMetrics {
  const { items: allEntities } = useEntities()
  const { items: allTrackers } = useTrackers()
  const weekStart = getWeekStart()

  const completed = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          (e.type === 'task' || e.type === 'goal') &&
          e.status === 'done' &&
          e.updatedAt.split('T')[0] >= weekStart,
      ),
    [allEntities, weekStart],
  )

  const habitSummaries = useMemo(() => {
    const habits = allEntities.filter((e) => e.type === 'habit' && e.status === 'todo')
    return habits.map((habit) => {
      const checkIns = allTrackers.filter(
        (t) => t.entityId === habit.id && t.timestamp.split('T')[0] >= weekStart,
      ).length
      const streak =
        typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
      return { habit, checkIns, streak }
    })
  }, [allEntities, allTrackers, weekStart])

  const inboxCount = useMemo(
    () => allEntities.filter((e) => e.metadata.isInbox === true && e.status === 'todo').length,
    [allEntities],
  )

  return { weekStart, completed, habitSummaries, inboxCount }
}
