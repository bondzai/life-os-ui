import { notify } from '@/lib/notify'
import type { Entity } from '@/core/types'
import type { ActionType, Condition, ScheduleInterval } from './automate-helpers'
// Rule template definitions are in automate-helpers.ts
import { addRun } from './automation-runs'
import type { AutomationEvent } from './automation-event-bus'

const STORAGE_KEY = 'lyra:entities'
const TRACKER_KEY = 'lyra:trackers'
const ENGINE_LAST_RUN_KEY = 'lyra:automation-last-run'
const RULE_TEMPLATES_KEY = 'lyra:automation-rules'

/** Life domains and their associated entity tags/types for the domain-inactive rule */
const LIFE_DOMAINS: Record<string, string[]> = {
  Health: ['health', 'workout', 'body-metric', 'sleep-mood', 'water-intake'],
  Wealth: ['wealth', 'finance', 'transaction', 'budget', 'account'],
  Learning: ['learning', 'book', 'course', 'skill'],
  Travel: ['travel', 'trip', 'place'],
  Family: ['family', 'relationship'],
}

/** Read enabled rule template IDs from localStorage */
export function getEnabledRuleTemplates(): Record<string, boolean> {
  const raw = localStorage.getItem(RULE_TEMPLATES_KEY)
  return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
}

/** Save enabled rule template states to localStorage */
export function setEnabledRuleTemplates(state: Record<string, boolean>): void {
  localStorage.setItem(RULE_TEMPLATES_KEY, JSON.stringify(state))
}

/** Check if a specific rule template is enabled */
function isRuleEnabled(ruleId: string): boolean {
  const state = getEnabledRuleTemplates()
  return state[ruleId] === true
}

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

function checkConditions(automation: Entity): boolean {
  const conditions = automation.metadata.conditions as Condition[] | undefined
  if (!conditions || conditions.length === 0) return true

  const entities = readEntities()
  const trackers: { entityId: string }[] = (() => {
    const raw = localStorage.getItem(TRACKER_KEY)
    return raw ? JSON.parse(raw) : []
  })()

  // AND logic: all conditions must pass
  return conditions.every((condition) => {
    switch (condition.field) {
      case 'entityStatus': {
        const matching = entities.filter((e) => e.status === condition.value)
        return evalCount(matching.length, condition.operator, condition.value)
      }
      case 'entityType': {
        const matching = entities.filter((e) => e.type === condition.value)
        return matching.length > 0
      }
      case 'tag': {
        const matching = entities.filter((e) => e.tags.includes(condition.value))
        return evalExists(matching.length, condition.operator)
      }
      case 'trackerCount': {
        const count = trackers.length
        return evalNumeric(count, condition.operator, parseInt(condition.value, 10) || 0)
      }
      default:
        return true
    }
  })
}

function evalCount(count: number, op: string, _value: string): boolean {
  // For status/type checks: just check existence
  switch (op) {
    case 'eq': return count > 0
    case 'neq': return count === 0
    case 'gte': return count >= 1
    case 'lte': return count === 0
    default: return count > 0
  }
}

function evalExists(count: number, op: string): boolean {
  switch (op) {
    case 'eq':
    case 'contains':
    case 'gte': return count > 0
    case 'neq': return count === 0
    default: return count > 0
  }
}

function evalNumeric(actual: number, op: string, expected: number): boolean {
  switch (op) {
    case 'eq': return actual === expected
    case 'neq': return actual !== expected
    case 'gte': return actual >= expected
    case 'lte': return actual <= expected
    default: return true
  }
}

function describeAction(automation: Entity): string {
  const actionType = automation.metadata.actionType as ActionType
  const actionConfig = automation.metadata.actionConfig as Record<string, unknown>

  switch (actionType) {
    case 'create-entity':
      return `Would create ${actionConfig.entityType || 'task'}: "${actionConfig.title || 'Automated task'}"`
    case 'notify':
      return `Would send notification: "${actionConfig.notifyTitle || automation.title}"`
    case 'update-entities': {
      const from = actionConfig.targetStatus ? ` from ${actionConfig.targetStatus}` : ''
      return `Would update ${actionConfig.targetType}s${from} to ${actionConfig.newStatus}`
    }
    default:
      return 'Unknown action'
  }
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
        status: 'todo',
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

export function runAutomation(
  automation: Entity,
  ownerId: string,
  options?: { dryRun?: boolean },
): string | void {
  // Check conditions
  if (!checkConditions(automation)) {
    if (options?.dryRun) {
      return 'Conditions not met — automation would be skipped.'
    }
    return
  }

  // Dry-run mode
  if (options?.dryRun) {
    const conditions = automation.metadata.conditions as Condition[] | undefined
    const condDesc = conditions && conditions.length > 0
      ? `\nConditions (${conditions.length}): all passed`
      : '\nNo conditions configured'
    return describeAction(automation) + condDesc
  }

  try {
    executeAction(automation, ownerId)
    addRun({
      id: crypto.randomUUID(),
      automationId: automation.id,
      automationTitle: automation.title,
      timestamp: new Date().toISOString(),
      result: 'success',
      details: describeAction(automation),
    })
  } catch (err) {
    addRun({
      id: crypto.randomUUID(),
      automationId: automation.id,
      automationTitle: automation.title,
      timestamp: new Date().toISOString(),
      result: 'error',
      details: err instanceof Error ? err.message : 'Unknown error',
    })
  }

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
      e.status === 'todo' &&
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

  // Run domain-inactive check (daily rule template)
  checkDomainInactivity(ownerId)

  return count
}

/** Execute built-in rule templates based on events */
function executeRuleTemplates(event: AutomationEvent, ownerId: string): void {
  // task-done-update-project
  if (
    isRuleEnabled('task-done-update-project') &&
    event.type === 'entity-status-change' &&
    event.entityType === 'task' &&
    event.newStatus === 'done' &&
    event.projectId
  ) {
    const entities = readEntities()
    const project = entities.find((e) => e.id === event.projectId)
    const taskTitle = event.entityTitle || 'A task'
    if (project) {
      notify({
        title: 'Project Progress',
        message: `"${taskTitle}" completed for project "${project.title}"`,
        type: 'info',
      })
      addRun({
        id: crypto.randomUUID(),
        automationId: 'task-done-update-project',
        automationTitle: 'Task Done → Track Project',
        timestamp: new Date().toISOString(),
        result: 'success',
        details: `Logged completion of "${taskTitle}" for project "${project.title}"`,
      })
    }
  }

  // habit-streak-break
  if (
    isRuleEnabled('habit-streak-break') &&
    event.type === 'habit-streak-reset' &&
    event.entityType === 'habit'
  ) {
    const habitName = event.entityTitle || 'Unknown habit'
    const entities = readEntities()
    const newTask: Entity = {
      id: crypto.randomUUID(),
      type: 'task',
      title: `Restart "${habitName}" habit`,
      description: `Your streak for "${habitName}" was reset. Time to get back on track!`,
      status: 'todo',
      priority: 'high',
      tags: ['habit', 'restart'],
      metadata: { ruleTemplateId: 'habit-streak-break' },
      ownerId,
      visibility: 'private',
      dueDate: new Date().toISOString().split('T')[0],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    writeEntities([...entities, newTask])
    notify({
      title: 'Habit Streak Broken',
      message: `Created reminder task: Restart "${habitName}" habit`,
      type: 'warning',
    })
    addRun({
      id: crypto.randomUUID(),
      automationId: 'habit-streak-break',
      automationTitle: 'Habit Streak Break → Reminder',
      timestamp: new Date().toISOString(),
      result: 'success',
      details: `Created restart task for habit "${habitName}"`,
    })
  }

  // goal-complete
  if (
    isRuleEnabled('goal-complete') &&
    event.type === 'entity-status-change' &&
    event.entityType === 'goal' &&
    event.newStatus === 'done'
  ) {
    const entities = readEntities()
    const goal = entities.find((e) => e.id === event.entityId)
    const goalTitle = goal?.title || event.entityTitle || 'A goal'

    // Archive the goal
    const updatedEntities = entities.map((e) => {
      if (e.id === event.entityId) {
        return { ...e, status: 'archived' as const, updatedAt: new Date().toISOString() }
      }
      return e
    })

    // Create celebration note
    const celebrationNote: Entity = {
      id: crypto.randomUUID(),
      type: 'note',
      title: `Goal completed: ${goalTitle}`,
      description: `Congratulations! You completed your goal "${goalTitle}" on ${new Date().toLocaleDateString()}.`,
      status: 'done',
      priority: 'low',
      tags: ['celebration', 'milestone'],
      metadata: { ruleTemplateId: 'goal-complete', goalId: event.entityId },
      ownerId,
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    writeEntities([...updatedEntities, celebrationNote])
    notify({
      title: 'Goal Completed!',
      message: `"${goalTitle}" has been archived and a celebration note was created.`,
      type: 'success',
    })
    addRun({
      id: crypto.randomUUID(),
      automationId: 'goal-complete',
      automationTitle: 'Goal Complete → Archive & Celebrate',
      timestamp: new Date().toISOString(),
      result: 'success',
      details: `Archived goal "${goalTitle}" and created celebration note`,
    })
  }

  // focus-session-log
  if (
    isRuleEnabled('focus-session-log') &&
    event.type === 'focus-session-end' &&
    event.projectId
  ) {
    const entities = readEntities()
    const project = entities.find((e) => e.id === event.projectId)
    const minutes = event.duration || 0
    const projectTitle = project?.title || 'Unknown project'

    if (project) {
      // Update project metadata with logged time
      const updatedEntities = entities.map((e) => {
        if (e.id === event.projectId) {
          const totalMinutes = ((e.metadata.totalFocusMinutes as number) || 0) + minutes
          return {
            ...e,
            metadata: { ...e.metadata, totalFocusMinutes: totalMinutes },
            updatedAt: new Date().toISOString(),
          }
        }
        return e
      })
      writeEntities(updatedEntities)
    }

    notify({
      title: 'Focus Session Logged',
      message: `${minutes} minutes logged to project "${projectTitle}"`,
      type: 'info',
    })
    addRun({
      id: crypto.randomUUID(),
      automationId: 'focus-session-log',
      automationTitle: 'Focus Session → Log Time',
      timestamp: new Date().toISOString(),
      result: 'success',
      details: `Logged ${minutes} min to project "${projectTitle}"`,
    })
  }
}

/** Run domain-inactive check (called from schedule runner) */
export function checkDomainInactivity(_ownerId: string): void {
  if (!isRuleEnabled('domain-inactive')) return

  const entities = readEntities()
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const cutoff = sevenDaysAgo.toISOString()

  const inactiveDomains: string[] = []

  for (const [domain, keywords] of Object.entries(LIFE_DOMAINS)) {
    const domainEntities = entities.filter((e) => {
      const matchesTags = e.tags.some((t) => keywords.includes(t.toLowerCase()))
      const matchesType = keywords.includes(e.type)
      return matchesTags || matchesType
    })

    if (domainEntities.length === 0) {
      // No entities in this domain at all — consider inactive
      inactiveDomains.push(domain)
      continue
    }

    const lastUpdate = domainEntities.reduce((latest, e) => {
      return e.updatedAt > latest ? e.updatedAt : latest
    }, '')

    if (lastUpdate < cutoff) {
      inactiveDomains.push(domain)
    }
  }

  if (inactiveDomains.length > 0) {
    notify({
      title: 'Inactive Domains Alert',
      message: `These life domains have been inactive for 7+ days: ${inactiveDomains.join(', ')}`,
      type: 'warning',
    })
    addRun({
      id: crypto.randomUUID(),
      automationId: 'domain-inactive',
      automationTitle: 'Domain Inactive → Alert',
      timestamp: new Date().toISOString(),
      result: 'success',
      details: `Inactive domains: ${inactiveDomains.join(', ')}`,
    })
  }
}

export function handleAutomationEvent(event: AutomationEvent, ownerId: string): void {
  // First, run built-in rule templates
  executeRuleTemplates(event, ownerId)

  // Then run user-created event automations
  const entities = readEntities()
  const automations = entities.filter(
    (e) =>
      e.type === 'automation' &&
      e.status === 'todo' &&
      e.metadata.triggerType === 'event' &&
      e.metadata.enabled !== false,
  )

  for (const automation of automations) {
    const eventConfig = automation.metadata.eventConfig as Record<string, unknown> | undefined
    if (!eventConfig) continue

    const watchType = eventConfig.watchType as string | undefined
    const watchStatus = eventConfig.watchStatus as string | undefined

    // Match event
    if (event.type === 'entity-status-change') {
      if (watchType && watchType !== event.entityType) continue
      if (watchStatus && watchStatus !== event.newStatus) continue
    } else if (event.type === 'tracker-created') {
      if (watchType && watchType !== event.entityType) continue
    } else {
      continue
    }

    runAutomation(automation, ownerId)
  }
}
