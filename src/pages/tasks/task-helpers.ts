import type { Entity } from '@/core/types'

// ─── Recurrence ───

export const RECURRENCE_OPTIONS = ['none', 'daily', 'weekly', 'biweekly', 'monthly'] as const
export type Recurrence = (typeof RECURRENCE_OPTIONS)[number]

export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  none: 'None',
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
}

export function getRecurrence(metadata: Record<string, unknown>): Recurrence {
  const r = metadata.recurring
  if (typeof r === 'string' && RECURRENCE_OPTIONS.includes(r as Recurrence)) return r as Recurrence
  return 'none'
}

/** Calculate the next due date based on recurrence frequency */
export function nextDueDate(currentDue: string | undefined, recurrence: Recurrence): string {
  const base = currentDue ? new Date(currentDue + 'T00:00:00') : new Date()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  // If the base is in the past, start from today
  if (base < today) base.setTime(today.getTime())

  switch (recurrence) {
    case 'daily': base.setDate(base.getDate() + 1); break
    case 'weekly': base.setDate(base.getDate() + 7); break
    case 'biweekly': base.setDate(base.getDate() + 14); break
    case 'monthly': base.setMonth(base.getMonth() + 1); break
    default: break
  }
  return base.toISOString().split('T')[0]
}

/** Build a new entity object for the next recurring occurrence */
export function buildRecurringNext(task: Entity): Omit<Entity, 'id' | 'createdAt' | 'updatedAt'> {
  const recurrence = getRecurrence(task.metadata)
  const newDue = nextDueDate(task.dueDate, recurrence)
  return {
    type: task.type,
    title: task.title,
    description: task.description,
    status: 'todo',
    priority: task.priority,
    tags: [...task.tags],
    metadata: {
      ...task.metadata,
      // Clear subtask progress
      subtasks: Array.isArray(task.metadata.subtasks)
        ? (task.metadata.subtasks as Array<Record<string, unknown>>).map((s) => ({
            ...s,
            done: false,
            status: 'todo',
          }))
        : undefined,
      recurringSourceId: task.metadata.recurringSourceId ?? task.id,
    },
    parentId: task.parentId,
    ownerId: task.ownerId,
    visibility: task.visibility,
    dueDate: newDue,
  }
}

// ─── Subtasks ───

export type SubtaskStatus = 'todo' | 'in-progress' | 'done'

export interface Subtask {
  id: string
  title: string
  done: boolean
  status?: SubtaskStatus
}

/** Resolve effective status — backwards compatible with legacy `done` field */
export function subtaskStatus(s: Subtask): SubtaskStatus {
  if (s.status) return s.status
  return s.done ? 'done' : 'todo'
}

/** Check if subtask is considered completed */
export function subtaskDone(s: Subtask): boolean {
  return subtaskStatus(s) === 'done'
}

export function isStory(task: Entity): boolean {
  return !!task.metadata.isStory || (Array.isArray(task.metadata.subtasks) && (task.metadata.subtasks as unknown[]).length > 0)
}

export function getSubtasks(metadata: Record<string, unknown>): Subtask[] {
  if (Array.isArray(metadata.subtasks)) return metadata.subtasks as Subtask[]
  return []
}

export function getSubtaskProgress(metadata: Record<string, unknown>): { done: number; total: number; pct: number } | null {
  const subs = getSubtasks(metadata)
  if (subs.length === 0) return null
  const done = subs.filter((s) => subtaskDone(s)).length
  return { done, total: subs.length, pct: Math.round((done / subs.length) * 100) }
}

export function isOverdue(dueDate: string | undefined, status: string): boolean {
  if (!dueDate || status === 'done') return false
  return dueDate < new Date().toISOString().split('T')[0]
}

export function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
