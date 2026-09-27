export type EntityType =
  // A workspace is the container the others hang off — one area of your life, with authored
  // context of its own in the knowledge tree under `workspaces/<slug>/`. See docs/workspaces.md.
  | 'workspace'
  | 'goal'
  | 'project'
  | 'task'
  | 'habit'
  | 'skill'
  | 'transaction'
  | 'budget'
  | 'account'
  | 'workout'
  | 'body-metric'
  | 'book'
  | 'course'
  | 'event'
  | 'device'
  | 'service'
  | 'chore'
  | 'note'
  | 'post'
  | 'place'
  | 'trip'
  | 'asset'
  | 'wallet'
  | 'crypto-tx'
  | 'sleep-mood'
  | 'water-intake'
  | 'automation'
  | 'memory'
  | 'comment'
  | 'location'

export type EntityStatus = 'backlog' | 'todo' | 'in-progress' | 'done' | 'archived'

export type EntityPriority = 'low' | 'medium' | 'high' | 'urgent'

export type EntityVisibility = 'private' | 'shared'

export interface Entity {
  id: string
  type: EntityType
  title: string
  description?: string
  status: EntityStatus
  priority: EntityPriority
  tags: string[]
  metadata: Record<string, unknown>
  parentId?: string
  ownerId: string
  visibility: EntityVisibility
  dueDate?: string
  createdAt: string
  updatedAt: string
}

// ─── Simplified type helpers ───
// Project is now Goal. Chore is now Task. Old data still works.
export const isGoal = (e: Entity) => e.type === 'goal' || e.type === 'project'
export const isTask = (e: Entity) => e.type === 'task' || e.type === 'chore'

/**
 * The statuses that mean a task is still to be done — named, rather than inferred as "anything
 * that is not done or archived".
 *
 * The difference is not academic. A one-time import on 2026-03-14 brought in rows with an older
 * vocabulary — `completed`, `active`, `paused` — that nothing in the app writes or understands. A
 * rule that excludes the closed statuses it knows about counts every one of those as open, so the
 * sidebar badge said 12 tasks were due while the Tasks page, which lists only these two statuses,
 * showed none of them. An allowlist makes an unknown status invisible instead of urgent.
 */
export const OPEN_TASK_STATUSES: readonly EntityStatus[] = ['todo', 'in-progress']

/**
 * A task that is open and due on or before `today` (a local `YYYY-MM-DD`, from `dateKey`).
 *
 * The single definition the sidebar badge and the Tasks page's "Today" group both use. They had
 * one each, and they disagreed — which is how a badge ends up promising work the page cannot show.
 */
export function isDueTask(e: Entity, today: string): boolean {
  return (
    isTask(e) &&
    OPEN_TASK_STATUSES.includes(e.status) &&
    Boolean(e.dueDate) &&
    // Compared on the day, so a stored timestamp and a stored date agree about what is due.
    (e.dueDate as string).slice(0, 10) <= today
  )
}
