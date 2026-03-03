import { notify } from '@/lib/notify'
import type { Entity } from '@/core/types'
import type { ActionType, ScheduleInterval } from './automate-helpers'

const STORAGE_KEY = 'life-os:entities'
const ENGINE_LAST_RUN_KEY = 'life-os:automation-last-run'

function readEntities(): Entity[] {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw ? (JSON.parse(raw) as Entity[]) : []
}

function writeEntities(entities: Entity[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entities))
}

function getNextDue(interval: ScheduleInterval, fromDate: string): string {
  const d = new Date(fromDate)
  switch (interval) {
    case 'daily':
      d.setDate(d.getDate() + 1)
      break
    case 'weekly':
      d.setDate(d.getDate() + 7)
      break
    case 'monthly':
      d.setMonth(d.getMonth() + 1)
      break
  }
  return d.toISOString().split('T')[0]
}

function executeAction(automation: Entity, ownerId: string): void {
  const actionType = automation.metadata.actionType as ActionType
  const actionConfig = automation.metadata.actionConfig as Record<string, unknown>

  switch (actionType) {
    case 'create-entity': {
      const entities = readEntities()
      const newEntity: Entity = {
        id: crypto.randomUUID(),
        type: (actionConfig.entityType as Entity['type']) || 'task',
        title: (actionConfig.title as string) || 'Automated task',
        status: 'active',
        priority: (actionConfig.priority as Entity['priority']) || 'medium',
        tags: (actionConfig.tags as string[]) || [],
        metadata: { automationId: automation.id },
        ownerId,
        visibility: 'shared',
        dueDate: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      writeEntities([...entities, newEntity])
      notify({
        title: `Automation: ${automation.title}`,
        message: `Created "${newEntity.title}"`,
        type: 'info',
      })
      break
    }
    case 'notify': {
      notify({
        title: (actionConfig.notifyTitle as string) || automation.title,
        message: (actionConfig.notifyMessage as string) || undefined,
        type: 'info',
      })
      break
    }
    case 'update-entities': {
      const targetType = actionConfig.targetType as string | undefined
      const targetStatus = actionConfig.targetStatus as string | undefined
      const newStatus = actionConfig.newStatus as string | undefined
      if (!targetType || !newStatus) break

      const entities = readEntities()
      let updated = 0
      const updatedEntities = entities.map((e) => {
        if (e.type === targetType && (!targetStatus || e.status === targetStatus)) {
          updated++
          return { ...e, status: newStatus as Entity['status'], updatedAt: new Date().toISOString() }
        }
        return e
      })
      if (updated > 0) {
        writeEntities(updatedEntities)
        notify({
          title: `Automation: ${automation.title}`,
          message: `Updated ${updated} ${targetType}(s)`,
          type: 'info',
        })
      }
      break
    }
  }
}

export function runAutomation(automation: Entity, ownerId: string): void {
  executeAction(automation, ownerId)

  // Update lastRun and runCount
  const entities = readEntities()
  const now = new Date().toISOString()
  const updatedEntities = entities.map((e) => {
    if (e.id === automation.id) {
      const runCount = ((e.metadata.runCount as number) || 0) + 1
      const scheduleInterval = e.metadata.scheduleInterval as ScheduleInterval | undefined
      const nextDue = scheduleInterval ? getNextDue(scheduleInterval, now) : undefined
      return {
        ...e,
        metadata: { ...e.metadata, lastRun: now, runCount, nextDue },
        updatedAt: now,
      }
    }
    return e
  })
  writeEntities(updatedEntities)
}

export function runDueAutomations(ownerId: string): number {
  const today = new Date().toISOString().split('T')[0]

  // Prevent running multiple times in the same session
  const lastRun = sessionStorage.getItem(ENGINE_LAST_RUN_KEY)
  if (lastRun === today) return 0
  sessionStorage.setItem(ENGINE_LAST_RUN_KEY, today)

  const entities = readEntities()
  const automations = entities.filter(
    (e) =>
      e.type === 'automation' &&
      e.status === 'active' &&
      e.metadata.triggerType === 'schedule' &&
      e.metadata.enabled !== false,
  )

  let count = 0
  for (const automation of automations) {
    const nextDue = automation.metadata.nextDue as string | undefined
    const lastRunDate = automation.metadata.lastRun
      ? (automation.metadata.lastRun as string).split('T')[0]
      : undefined

    // Run if: no lastRun ever, or nextDue is today or past
    if (!lastRunDate || (nextDue && nextDue <= today)) {
      runAutomation(automation, ownerId)
      count++
    }
  }

  return count
}
