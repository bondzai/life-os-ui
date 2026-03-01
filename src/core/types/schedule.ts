export interface Schedule {
  id: string
  entityId: string
  recurrence: string
  nextDue: string
  lastCompleted?: string
  isActive: boolean
}
