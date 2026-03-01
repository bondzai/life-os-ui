export interface Tracker {
  id: string
  entityId: string
  value: number
  unit: string
  note?: string
  timestamp: string
  ownerId: string
}
