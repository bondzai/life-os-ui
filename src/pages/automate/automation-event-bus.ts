export type AutomationEventType = 'entity-status-change' | 'tracker-created'

export interface AutomationEvent {
  type: AutomationEventType
  entityId: string
  entityType: string
  newStatus?: string
  oldStatus?: string
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
