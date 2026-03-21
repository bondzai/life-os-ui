export type AutomationEventType =
  | 'entity-status-change'
  | 'tracker-created'
  | 'habit-streak-reset'
  | 'focus-session-end'

export interface AutomationEvent {
  type: AutomationEventType
  entityId: string
  entityType: string
  entityTitle?: string
  newStatus?: string
  oldStatus?: string
  /** projectId from task metadata, used by focus-session-log */
  projectId?: string
  /** Duration in minutes, used by focus-session-end */
  duration?: number
  /** Habit streak value, used by habit-streak-reset */
  streakValue?: number
}

type Listener = (event: AutomationEvent) => void

const listeners: Listener[] = []

export function subscribeAutomationEvents(fn: Listener): () => void {
  listeners.push(fn)
  return () => {
    const idx = listeners.indexOf(fn)
    if (idx >= 0) listeners.splice(idx, 1)
  }
}

export function emitAutomationEvent(event: AutomationEvent): void {
  for (const fn of listeners) {
    try {
      fn(event)
    } catch {
      // Ignore listener errors
    }
  }
}
