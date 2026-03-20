import { useMemo } from 'react'
import type { Node, Edge } from '@xyflow/react'
import { useEntities } from '@/core/hooks'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'

const GOAL_SPACING_X = 400
const TASK_SPACING_X = 280
const SUBTASK_SPACING_X = 220
const TASK_OFFSET_Y = 180
const SUBTASK_OFFSET_Y = 150
const STALE_DAYS = 14

const UNCATEGORIZED_ID = '__uncategorized__'

interface Subtask {
  id: string
  title: string
  done: boolean
  status?: EntityStatus
  priority?: EntityPriority
}

function getSubtasks(entity: Entity): Subtask[] {
  const raw = entity.metadata?.subtasks
  return Array.isArray(raw) ? (raw as Subtask[]) : []
}

function centerOffset(count: number, spacing: number): number {
  return -((count - 1) * spacing) / 2
}

function isStale(entity: Entity): boolean {
  const updated = entity.updatedAt ?? entity.createdAt
  if (!updated) return false
  return Date.now() - new Date(updated).getTime() > STALE_DAYS * 86400000
}

export function useGoalGraph() {
  const { items } = useEntities()

  return useMemo(() => {
    const goals = items.filter((e) => e.type === 'goal' && e.status !== 'archived')
    const tasks = items.filter((e) => e.type === 'task' && e.status !== 'archived')

    const tasksByGoal = new Map<string, Entity[]>()
    const orphanTasks: Entity[] = []

    for (const task of tasks) {
      const goalId = task.metadata?.goalId as string | undefined
      if (goalId && goals.some((g) => g.id === goalId)) {
        const list = tasksByGoal.get(goalId) ?? []
        list.push(task)
        tasksByGoal.set(goalId, list)
      } else {
        orphanTasks.push(task)
      }
    }

    const hasOrphans = orphanTasks.length > 0
    const allRoots = hasOrphans ? [...goals, null] : goals
    const nodes: Node[] = []
    const edges: Edge[] = []

    allRoots.forEach((goal, goalIndex) => {
      const isVirtual = goal === null
      const goalId = isVirtual ? UNCATEGORIZED_ID : goal.id
      const goalX = goalIndex * GOAL_SPACING_X
      const goalY = 0

      const goalSubtasks = isVirtual ? [] : getSubtasks(goal)
      const childTasks = isVirtual ? orphanTasks : (tasksByGoal.get(goalId) ?? [])

      const allSubs = isVirtual
        ? childTasks.flatMap(getSubtasks)
        : [...goalSubtasks, ...childTasks.flatMap(getSubtasks)]
      const totalSubs = allSubs.length
      const doneSubs = allSubs.filter((s) => s.done).length
      const progress = totalSubs > 0 ? Math.round((doneSubs / totalSubs) * 100) : 0

      nodes.push({
        id: goalId,
        type: 'goal',
        position: { x: goalX, y: goalY },
        data: {
          entity: goal,
          title: isVirtual ? 'Uncategorized' : goal.title,
          status: isVirtual ? 'backlog' : goal.status,
          priority: isVirtual ? 'low' : goal.priority,
          progress,
          taskCount: childTasks.length,
          isStale: !isVirtual && isStale(goal),
        },
      })

      const taskOffsetX = centerOffset(childTasks.length, TASK_SPACING_X)

      childTasks.forEach((task, taskIndex) => {
        const taskId = task.id
        const taskX = goalX + taskOffsetX + taskIndex * TASK_SPACING_X
        const taskY = goalY + TASK_OFFSET_Y

        const subtasks = getSubtasks(task)
        const subtasksDone = subtasks.filter((s) => s.done).length

        nodes.push({
          id: taskId,
          type: 'task',
          position: { x: taskX, y: taskY },
          data: {
            entity: task,
            title: task.title,
            status: task.status,
            priority: task.priority,
            subtasksDone,
            subtasksTotal: subtasks.length,
            isStale: isStale(task),
          },
        })

        edges.push({
          id: `e-${goalId}-${taskId}`,
          source: goalId,
          target: taskId,
          style: { stroke: 'hsl(var(--border))' },
        })

        const subOffsetX = centerOffset(subtasks.length, SUBTASK_SPACING_X)

        subtasks.forEach((sub, subIndex) => {
          const subNodeId = `${taskId}__sub__${sub.id}`
          const subX = taskX + subOffsetX + subIndex * SUBTASK_SPACING_X
          const subY = taskY + SUBTASK_OFFSET_Y

          nodes.push({
            id: subNodeId,
            type: 'subtask',
            position: { x: subX, y: subY },
            data: {
              title: sub.title,
              done: sub.done,
              priority: sub.priority ?? 'medium',
              taskId,
              subtaskId: sub.id,
            },
          })

          edges.push({
            id: `e-${taskId}-${subNodeId}`,
            source: taskId,
            target: subNodeId,
            style: { stroke: 'hsl(var(--border))' },
          })
        })
      })
    })

    return { nodes, edges, goals, tasks }
  }, [items])
}
