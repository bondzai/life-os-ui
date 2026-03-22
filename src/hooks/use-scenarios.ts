import { useMemo } from 'react'
import { useEntities } from '@/core/hooks'
import type { Entity } from '@/core/types'

const MS_PER_DAY = 86_400_000
const MS_PER_WEEK = 7 * MS_PER_DAY

export interface ScenarioTimeline {
  weeksNeeded: number
  projectedDate: string
  velocity: number
}

export interface EntityScenario {
  entity: Entity
  totalTasks: number
  completedTasks: number
  remainingTasks: number
  optimistic: ScenarioTimeline
  realistic: ScenarioTimeline
  pessimistic: ScenarioTimeline
  dueDate: string | null
  riskLevel: 'on-track' | 'at-risk' | 'will-miss'
}

export function useScenarios() {
  const { items: entities } = useEntities()

  return useMemo((): EntityScenario[] => {
    const now = Date.now()
    const results: EntityScenario[] = []

    const candidates = entities.filter(e =>
      (e.type === 'project' || e.type === 'goal') &&
      e.status !== 'done' && e.status !== 'archived'
    )

    for (const entity of candidates) {
      const tasks = entities.filter(e =>
        e.type === 'task' && e.status !== 'archived' &&
        (e.metadata?.projectId === entity.id || e.metadata?.goalId === entity.id)
      )
      if (tasks.length === 0) continue

      const completed = tasks.filter(t => t.status === 'done').length
      const remaining = tasks.length - completed
      if (remaining === 0) continue

      // Weekly velocity over last 4 weeks
      const weeklyVelocities: number[] = []
      for (let w = 0; w < 4; w++) {
        const weekStart = new Date(now - (w + 1) * MS_PER_WEEK).toISOString()
        const weekEnd = new Date(now - w * MS_PER_WEEK).toISOString()
        const done = tasks.filter(t => t.status === 'done' && t.updatedAt >= weekStart && t.updatedAt < weekEnd).length
        weeklyVelocities.push(done)
      }

      const validVelocities = weeklyVelocities.filter(v => v > 0)
      if (validVelocities.length === 0) {
        // Zero velocity — can't project
        results.push({
          entity,
          totalTasks: tasks.length,
          completedTasks: completed,
          remainingTasks: remaining,
          optimistic: { weeksNeeded: Infinity, projectedDate: 'Never', velocity: 0 },
          realistic: { weeksNeeded: Infinity, projectedDate: 'Never', velocity: 0 },
          pessimistic: { weeksNeeded: Infinity, projectedDate: 'Never', velocity: 0 },
          dueDate: entity.dueDate ?? null,
          riskLevel: entity.dueDate ? 'will-miss' : 'at-risk',
        })
        continue
      }

      const best = Math.max(...validVelocities)
      const avg = validVelocities.reduce((a, b) => a + b, 0) / validVelocities.length
      const worst = Math.min(...validVelocities)

      function timeline(velocity: number): ScenarioTimeline {
        const weeks = velocity > 0 ? remaining / velocity : Infinity
        const ms = now + weeks * MS_PER_WEEK
        return {
          weeksNeeded: Math.round(weeks * 10) / 10,
          projectedDate: weeks === Infinity ? 'Never' : new Date(ms).toISOString().split('T')[0],
          velocity,
        }
      }

      const optimistic = timeline(best)
      const realistic = timeline(avg)
      const pessimistic = timeline(worst)

      let riskLevel: 'on-track' | 'at-risk' | 'will-miss' = 'on-track'
      if (entity.dueDate) {
        const dueMs = new Date(entity.dueDate).getTime()
        const realisticMs = now + realistic.weeksNeeded * MS_PER_WEEK
        if (realisticMs > dueMs) riskLevel = 'will-miss'
        else if (realisticMs > dueMs - 7 * MS_PER_DAY) riskLevel = 'at-risk'
      }

      results.push({
        entity,
        totalTasks: tasks.length,
        completedTasks: completed,
        remainingTasks: remaining,
        optimistic,
        realistic,
        pessimistic,
        dueDate: entity.dueDate ?? null,
        riskLevel,
      })
    }

    return results.sort((a, b) => {
      const riskOrder = { 'will-miss': 0, 'at-risk': 1, 'on-track': 2 }
      return (riskOrder[a.riskLevel] ?? 2) - (riskOrder[b.riskLevel] ?? 2)
    })
  }, [entities])
}
