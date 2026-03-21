import { useMemo } from 'react'
import { useEntities, useRelations } from '@/core/hooks'
import { modules } from '@/core/config/modules'
import type { Entity, EntityType } from '@/core/types'

/* ─── Types ─── */

export interface CascadeNode {
  goal: Entity
  subGoals: CascadeNode[]
  linkedTasks: Entity[]
  progress: number
  isStale: boolean
  isBlocked: boolean
  downstreamCount: number
  depth: number
}

export type DomainStatus = 'green' | 'yellow' | 'red'

export interface DomainHealth {
  id: string
  label: string
  status: DomainStatus
  lastActivityDays: number | null
  goalCount: number
  goalsDone: number
  entityCount: number
  path: string
}

export interface LeverageTask {
  task: Entity
  score: number
  unblocks: string[]
}

/* ─── Constants ─── */

const STALE_DAYS = 14
const YELLOW_DAYS = 7
const MS_PER_DAY = 86_400_000

/* ─── Helpers ─── */

function daysSince(dateStr: string | undefined): number | null {
  if (!dateStr) return null
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / MS_PER_DAY)
}

function isStale(entity: Entity): boolean {
  const d = daysSince(entity.updatedAt ?? entity.createdAt)
  return d !== null && d >= STALE_DAYS
}

function isIncomplete(entity: Entity): boolean {
  return entity.status !== 'done' && entity.status !== 'archived'
}

/* ─── Domain health mapping ─── */

const LIFE_DOMAINS = modules
  .filter((m) => m.group === 'Life' && m.entityTypes.length > 0)
  .map((m) => ({ id: m.id, label: m.label, entityTypes: m.entityTypes, path: m.path }))

/* ─── Hook ─── */

export function useCommandCenter() {
  const { items: entities } = useEntities()
  const { items: relations } = useRelations()

  return useMemo(() => {
    const now = Date.now()
    const goals = entities.filter((e) => e.type === 'goal' && e.status !== 'archived')
    const tasks = entities.filter((e) => e.type === 'task' && e.status !== 'archived')

    // Index maps
    const entityById = new Map<string, Entity>()
    for (const e of entities) entityById.set(e.id, e)

    const tasksByGoal = new Map<string, Entity[]>()
    for (const t of tasks) {
      const goalId = t.metadata?.goalId as string | undefined
      if (goalId) {
        const list = tasksByGoal.get(goalId) ?? []
        list.push(t)
        tasksByGoal.set(goalId, list)
      }
    }

    // Blocks graph: blockerOf[A] = [B, C] means A blocks B and C
    const blockerOf = new Map<string, string[]>()
    const blockedBy = new Map<string, string[]>()
    for (const r of relations) {
      if (r.type === 'blocks') {
        const list = blockerOf.get(r.fromId) ?? []
        list.push(r.toId)
        blockerOf.set(r.fromId, list)
        const deps = blockedBy.get(r.toId) ?? []
        deps.push(r.fromId)
        blockedBy.set(r.toId, deps)
      }
    }

    // Check if entity is blocked (has incomplete blockers)
    function entityIsBlocked(id: string): boolean {
      const deps = blockedBy.get(id)
      if (!deps) return false
      return deps.some((depId) => {
        const dep = entityById.get(depId)
        return dep && isIncomplete(dep)
      })
    }

    // Count downstream entities (recursive) via parentId and blocks relations
    function countDownstream(id: string, visited = new Set<string>()): number {
      if (visited.has(id)) return 0
      visited.add(id)
      let count = 0

      // Children by parentId
      const children = goals.filter((g) => g.parentId === id)
      for (const child of children) {
        count += 1 + countDownstream(child.id, visited)
      }

      // Linked tasks
      const linkedTasks = tasksByGoal.get(id) ?? []
      count += linkedTasks.length

      // Things this entity blocks
      const blocked = blockerOf.get(id) ?? []
      for (const bId of blocked) {
        if (!visited.has(bId)) {
          count += 1 + countDownstream(bId, visited)
        }
      }

      return count
    }

    /* ── 1. Goal Cascade Tree ── */

    function buildCascade(goal: Entity, depth: number): CascadeNode {
      const subGoals = goals
        .filter((g) => g.parentId === goal.id)
        .map((g) => buildCascade(g, depth + 1))

      const linkedTasks = tasksByGoal.get(goal.id) ?? []

      // Progress: aggregate from sub-goals and linked tasks
      const allItems = [
        ...subGoals.map((sg) => sg.progress),
        ...linkedTasks.map((t) => (t.status === 'done' ? 100 : t.status === 'in-progress' ? 50 : 0)),
      ]

      // If the goal itself has metadata.progress, use it for leaf goals
      const metaProgress = goal.metadata?.progress as number | undefined
      const progress =
        allItems.length > 0
          ? Math.round(allItems.reduce((a, b) => a + b, 0) / allItems.length)
          : metaProgress ?? 0

      const blocked = entityIsBlocked(goal.id) || linkedTasks.some((t) => entityIsBlocked(t.id))
      const downstreamCount = countDownstream(goal.id)

      return {
        goal,
        subGoals,
        linkedTasks,
        progress,
        isStale: isStale(goal),
        isBlocked: blocked,
        downstreamCount,
        depth,
      }
    }

    const topLevelGoals = goals.filter((g) => !g.parentId || !goals.some((p) => p.id === g.parentId))
    const cascadeTree = topLevelGoals.map((g) => buildCascade(g, 0))

    // Find the top blocked goal by downstream impact
    function findAllNodes(nodes: CascadeNode[]): CascadeNode[] {
      const result: CascadeNode[] = []
      for (const n of nodes) {
        result.push(n)
        result.push(...findAllNodes(n.subGoals))
      }
      return result
    }
    const allNodes = findAllNodes(cascadeTree)
    const topBlockedGoal = allNodes
      .filter((n) => n.isBlocked)
      .sort((a, b) => b.downstreamCount - a.downstreamCount)[0] ?? null

    /* ── 2. System Health Indicators ── */

    const domainHealth: DomainHealth[] = LIFE_DOMAINS.map((domain) => {
      const domainEntities = entities.filter(
        (e) => (domain.entityTypes as EntityType[]).includes(e.type) && e.status !== 'archived',
      )

      let mostRecentMs = 0
      for (const e of domainEntities) {
        const t = new Date(e.updatedAt ?? e.createdAt).getTime()
        if (t > mostRecentMs) mostRecentMs = t
      }

      const lastActivityDays = mostRecentMs > 0 ? Math.floor((now - mostRecentMs) / MS_PER_DAY) : null

      // Domain goals: goals tagged with domain id or label
      const domainGoals = goals.filter((g) =>
        g.tags.some((t) => t.toLowerCase() === domain.id || t.toLowerCase() === domain.label.toLowerCase()),
      )
      const goalsDone = domainGoals.filter((g) => g.status === 'done').length

      let status: DomainStatus = 'green'
      if (lastActivityDays === null || lastActivityDays >= STALE_DAYS) status = 'red'
      else if (lastActivityDays >= YELLOW_DAYS) status = 'yellow'

      return {
        id: domain.id,
        label: domain.label,
        status,
        lastActivityDays,
        goalCount: domainGoals.length,
        goalsDone,
        entityCount: domainEntities.length,
        path: domain.path,
      }
    })

    /* ── 3. Leverage Score ── */

    // For each incomplete task, calculate how many things it would unblock
    const leverageTasks: LeverageTask[] = []

    const incompleteTasks = tasks.filter(isIncomplete)

    for (const task of incompleteTasks) {
      const directlyUnblocks = blockerOf.get(task.id)
      if (!directlyUnblocks || directlyUnblocks.length === 0) continue

      const unblockNames: string[] = []
      let score = 0

      for (const targetId of directlyUnblocks) {
        const target = entityById.get(targetId)
        if (!target || !isIncomplete(target)) continue

        // Would completing this task fully unblock the target?
        const targetBlockers = blockedBy.get(targetId) ?? []
        const remainingBlockers = targetBlockers.filter((bId) => {
          if (bId === task.id) return false
          const b = entityById.get(bId)
          return b && isIncomplete(b)
        })

        if (remainingBlockers.length === 0) {
          score += 1 + countDownstream(targetId, new Set([task.id]))
          unblockNames.push(target.title)
        }
      }

      if (score > 0) {
        leverageTasks.push({ task, score, unblocks: unblockNames })
      }
    }

    // Sort by score desc, take top 5
    leverageTasks.sort((a, b) => b.score - a.score)
    const topLeverageTasks = leverageTasks.slice(0, 5)

    // Fallback: if no blocks relations, show highest-priority goal-linked tasks
    let fallbackTasks: Entity[] = []
    if (topLeverageTasks.length === 0) {
      const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
      fallbackTasks = incompleteTasks
        .filter((t) => t.metadata?.goalId)
        .sort((a, b) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3))
        .slice(0, 5)
    }

    return {
      cascadeTree,
      domainHealth,
      topLeverageTasks,
      fallbackTasks,
      topBlockedGoal,
      stats: {
        totalGoals: goals.length,
        totalTasks: tasks.length,
        blockedGoals: allNodes.filter((n) => n.isBlocked).length,
        staleGoals: allNodes.filter((n) => n.isStale).length,
      },
    }
  }, [entities, relations])
}
