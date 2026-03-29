export type EntityType =
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
