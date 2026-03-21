import { useMemo } from 'react'
import { useEntities, useTrackers } from '@/core/hooks'
import { modules } from '@/core/config/modules'
import type { Entity, EntityType } from '@/core/types'
import { daysAgo, getWeekStart } from './review-helpers'

/* ─── Types ─── */

export interface ProjectVelocity {
  project: Entity
  thisWeek: number
  lastWeek: number
  delta: number
}

export interface RiskDetection {
  habitsAtRisk: Entity[]
  staleGoals: Entity[]
  staleProjects: Entity[]
  overdueTasks: Entity[]
}

export type BalanceStatus = 'green' | 'yellow' | 'red'

export interface LifeBalanceItem {
  domain: string
  lastActivityDays: number | null
  status: BalanceStatus
}

/* ─── Constants ─── */

const MS_PER_DAY = 86_400_000
const STALE_DAYS = 14
const YELLOW_DAYS = 7

const LIFE_DOMAINS = modules
  .filter((m) => m.group === 'Life' && m.entityTypes.length > 0)
  .map((m) => ({ id: m.id, label: m.label, entityTypes: m.entityTypes }))

/* ─── Helpers ─── */

function getLastWeekStart(): string {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay() - 7)
  d.setHours(0, 0, 0, 0)
  return d.toISOString().split('T')[0]
}

/* ─── Hook ─── */

export function useSystemAudit() {
  const { items: entities } = useEntities()
  const { items: trackers } = useTrackers()

  const weekStart = getWeekStart()
  const lastWeekStart = getLastWeekStart()
  const today = new Date().toISOString().split('T')[0]
  const now = Date.now()

  return useMemo(() => {
    const projects = entities.filter((e) => e.type === 'project' && e.status !== 'archived')
    const tasks = entities.filter((e) => e.type === 'task')
    const goals = entities.filter((e) => e.type === 'goal')
    const habits = entities.filter((e) => e.type === 'habit')

    /* ── 1. Project Velocity ── */

    const projectVelocity: ProjectVelocity[] = projects.map((project) => {
      const projectTasks = tasks.filter(
        (t) => t.metadata.projectId === project.id && t.status === 'done',
      )

      const thisWeek = projectTasks.filter(
        (t) => t.updatedAt.split('T')[0] >= weekStart,
      ).length

      const lastWeek = projectTasks.filter(
        (t) => {
          const d = t.updatedAt.split('T')[0]
          return d >= lastWeekStart && d < weekStart
        },
      ).length

      return { project, thisWeek, lastWeek, delta: thisWeek - lastWeek }
    })

    /* ── 2. Risk Detection ── */

    // Habits at risk: active with streak > 0 but no tracker entry today
    const habitsAtRisk = habits.filter((h) => {
      if (h.status === 'done' || h.status === 'archived') return false
      const streak = typeof h.metadata.streak === 'number' ? (h.metadata.streak as number) : 0
      if (streak <= 0) return false
      const hasEntryToday = trackers.some(
        (t) => t.entityId === h.id && t.timestamp.split('T')[0] === today,
      )
      return !hasEntryToday
    })

    // Stale goals: updatedAt > 14 days ago and not done/archived
    const staleGoals = goals.filter(
      (g) =>
        g.status !== 'done' &&
        g.status !== 'archived' &&
        daysAgo(g.updatedAt) >= STALE_DAYS,
    )

    // Stale projects: no linked task activity in 14+ days
    const staleProjects = projects.filter((p) => {
      const linkedTasks = tasks.filter((t) => t.metadata.projectId === p.id)
      if (linkedTasks.length === 0) return daysAgo(p.updatedAt) >= STALE_DAYS
      const mostRecentTask = linkedTasks.reduce((latest, t) => {
        return new Date(t.updatedAt).getTime() > new Date(latest.updatedAt).getTime() ? t : latest
      })
      return daysAgo(mostRecentTask.updatedAt) >= STALE_DAYS
    })

    // Overdue tasks
    const overdueTasks = tasks.filter(
      (t) =>
        t.status !== 'done' &&
        t.status !== 'archived' &&
        t.dueDate != null &&
        t.dueDate < today,
    )

    const riskDetection: RiskDetection = {
      habitsAtRisk,
      staleGoals,
      staleProjects,
      overdueTasks,
    }

    /* ── 3. Life Balance ── */

    const lifeBalance: LifeBalanceItem[] = LIFE_DOMAINS.map((domain) => {
      const domainEntities = entities.filter(
        (e) =>
          (domain.entityTypes as EntityType[]).includes(e.type) &&
          e.status !== 'archived',
      )

      let mostRecentMs = 0
      for (const e of domainEntities) {
        const t = new Date(e.updatedAt ?? e.createdAt).getTime()
        if (t > mostRecentMs) mostRecentMs = t
      }

      const lastActivityDays =
        mostRecentMs > 0 ? Math.floor((now - mostRecentMs) / MS_PER_DAY) : null

      let status: BalanceStatus = 'green'
      if (lastActivityDays === null || lastActivityDays >= STALE_DAYS) status = 'red'
      else if (lastActivityDays >= YELLOW_DAYS) status = 'yellow'

      return { domain: domain.label, lastActivityDays, status }
    })

    /* ── 4. Suggested Priorities ── */

    const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

    // Collect at-risk goal IDs for linked task boosting
    const staleGoalIds = new Set(staleGoals.map((g) => g.id))

    const incompleteTasks = tasks.filter(
      (t) => t.status !== 'done' && t.status !== 'archived',
    )

    // Score each task for prioritisation
    const scored = incompleteTasks.map((t) => {
      let score = 0
      // Overdue gets highest priority
      if (t.dueDate && t.dueDate < today) score += 1000
      // Linked to at-risk goal
      if (staleGoalIds.has(t.metadata.goalId as string)) score += 500
      // Base priority
      score += (3 - (priorityOrder[t.priority] ?? 3)) * 100
      return { task: t, score }
    })

    scored.sort((a, b) => b.score - a.score)
    const suggestedPriorities: Entity[] = scored.slice(0, 5).map((s) => s.task)

    return {
      projectVelocity,
      riskDetection,
      lifeBalance,
      suggestedPriorities,
    }
  }, [entities, trackers, weekStart, lastWeekStart, today, now])
}
