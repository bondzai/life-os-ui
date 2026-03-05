export const TRIGGER_TYPES = ['schedule', 'manual', 'event'] as const
export type TriggerType = (typeof TRIGGER_TYPES)[number]

export const SCHEDULE_INTERVALS = ['daily', 'weekly', 'monthly'] as const
export type ScheduleInterval = (typeof SCHEDULE_INTERVALS)[number]

export const ACTION_TYPES = ['create-entity', 'notify', 'update-entities'] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  schedule: 'Scheduled',
  manual: 'Manual',
  event: 'Event-Driven',
}

export const SCHEDULE_LABELS: Record<ScheduleInterval, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
}

export const ACTION_LABELS: Record<ActionType, string> = {
  'create-entity': 'Create Entity',
  notify: 'Send Notification',
  'update-entities': 'Update Entities',
}

export const ACTION_COLORS: Record<ActionType, string> = {
  'create-entity': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  notify: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  'update-entities': 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
}

export type ConditionField = 'entityStatus' | 'entityType' | 'tag' | 'trackerCount'
export type ConditionOperator = 'eq' | 'neq' | 'gte' | 'lte' | 'contains'

export interface Condition {
  field: ConditionField
  operator: ConditionOperator
  value: string
}

export const CONDITION_FIELDS: { value: ConditionField; label: string }[] = [
  { value: 'entityStatus', label: 'Entity Status' },
  { value: 'entityType', label: 'Entity Type' },
  { value: 'tag', label: 'Tag' },
  { value: 'trackerCount', label: 'Tracker Count' },
]

export const CONDITION_OPERATORS: { value: ConditionOperator; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '!=' },
  { value: 'gte', label: '>=' },
  { value: 'lte', label: '<=' },
  { value: 'contains', label: 'contains' },
]

export interface AutomationTemplate {
  id: string
  name: string
  description: string
  triggerType: TriggerType
  scheduleInterval?: ScheduleInterval
  actionType: ActionType
  actionConfig: Record<string, unknown>
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'weekly-review',
    name: 'Weekly Review',
    description: 'Creates a "Weekly Review" task every Monday.',
    triggerType: 'schedule',
    scheduleInterval: 'weekly',
    actionType: 'create-entity',
    actionConfig: { entityType: 'task', title: 'Weekly review', tags: ['review'], priority: 'medium' },
  },
  {
    id: 'monthly-budget-reminder',
    name: 'Monthly Budget Check',
    description: 'Sends a reminder to review your budget on the 1st of each month.',
    triggerType: 'schedule',
    scheduleInterval: 'monthly',
    actionType: 'notify',
    actionConfig: { notifyTitle: 'Budget Review', notifyMessage: 'Time to review your monthly budget and spending.' },
  },
  {
    id: 'daily-habit-reminder',
    name: 'Daily Habit Reminder',
    description: 'Morning notification to complete your daily habits.',
    triggerType: 'schedule',
    scheduleInterval: 'daily',
    actionType: 'notify',
    actionConfig: { notifyTitle: 'Habit Check', notifyMessage: 'Don\'t forget to check in on your daily habits!' },
  },
  {
    id: 'weekly-meal-plan',
    name: 'Weekly Meal Plan',
    description: 'Creates a meal planning task every Sunday.',
    triggerType: 'schedule',
    scheduleInterval: 'weekly',
    actionType: 'create-entity',
    actionConfig: { entityType: 'task', title: 'Plan meals for the week', tags: ['cooking', 'planning'], priority: 'medium' },
  },
  {
    id: 'weekly-grocery-task',
    name: 'Weekly Grocery List',
    description: 'Creates a grocery shopping task every week.',
    triggerType: 'schedule',
    scheduleInterval: 'weekly',
    actionType: 'create-entity',
    actionConfig: { entityType: 'task', title: 'Weekly grocery shopping', tags: ['shopping', 'errands'], priority: 'medium' },
  },
]
