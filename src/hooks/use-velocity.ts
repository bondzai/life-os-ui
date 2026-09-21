import { useMemo } from 'react'
import { useEntities } from '@/core/hooks'

type RiskLevel = 'on-track' | 'at-risk' | 'will-miss'

export interface VelocityData {
  totalTasks: number
  completedTasks: number
  remainingTasks: number
  weeklyVelocity: number[]
  avgVelocity: number
  projectedWeeksLeft: number
  projectedDate: string | null
  riskLevel: RiskLevel
}

export function useVelocity(
  entityId: string,
  // Widened for Projects. The value is unused — the filter below already matches either link
  // field — but the parameter documents which hierarchy the caller thinks it is in.
  entityType: 'goal' | 'project',
  dueDate?: string,
): VelocityData {
  const { items: allTasks } = useEntities('task')

  return useMemo(() => {
    // Check both projectId and goalId — old entities may use either field
    const linkedTasks = allTasks.filter(
      (t) => t.status !== 'archived' && (t.metadata?.goalId === entityId || t.metadata?.projectId === entityId),
    )

    const totalTasks = linkedTasks.length
    const completedTasks = linkedTasks.filter((t) => t.status === 'done').length
    const remainingTasks = totalTasks - completedTasks

    // Compute weekly velocity for last 4 weeks
    const now = new Date()
    const weeklyVelocity: number[] = [0, 0, 0, 0]

    for (const task of linkedTasks) {
      if (task.status !== 'done') continue
      const updatedAt = new Date(task.updatedAt)
      const msAgo = now.getTime() - updatedAt.getTime()
      const weeksAgo = msAgo / (7 * 24 * 60 * 60 * 1000)

      if (weeksAgo < 1) {
        weeklyVelocity[3] += 1
      } else if (weeksAgo < 2) {
        weeklyVelocity[2] += 1
      } else if (weeksAgo < 3) {
        weeklyVelocity[1] += 1
      } else if (weeksAgo < 4) {
        weeklyVelocity[0] += 1
      }
    }

    const avgVelocity =
      weeklyVelocity.reduce((sum, v) => sum + v, 0) / weeklyVelocity.length

    const projectedWeeksLeft =
      avgVelocity > 0 ? remainingTasks / avgVelocity : Infinity

    let projectedDate: string | null = null
    if (isFinite(projectedWeeksLeft)) {
      const projected = new Date(now)
      projected.setDate(projected.getDate() + Math.ceil(projectedWeeksLeft * 7))
      projectedDate = projected.toISOString().split('T')[0]
    }

    let riskLevel: RiskLevel = 'on-track'
    if (dueDate && projectedDate) {
      const due = new Date(dueDate).getTime()
      const projected = new Date(projectedDate).getTime()
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000

      if (projected > due) {
        riskLevel = 'will-miss'
      } else if (due - projected < oneWeekMs) {
        riskLevel = 'at-risk'
      }
    }

    return {
      totalTasks,
      completedTasks,
      remainingTasks,
      weeklyVelocity,
      avgVelocity,
      projectedWeeksLeft,
      projectedDate,
      riskLevel,
    }
  }, [allTasks, entityId, entityType, dueDate])
}
