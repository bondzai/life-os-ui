import type { Entity } from '@/core/types'

export interface Subtask {
  id: string
  title: string
  done: boolean
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
  const done = subs.filter((s) => s.done).length
  return { done, total: subs.length, pct: Math.round((done / subs.length) * 100) }
}

export function isOverdue(dueDate: string | undefined, status: string): boolean {
  if (!dueDate || status === 'completed') return false
  return dueDate < new Date().toISOString().split('T')[0]
}

export function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
