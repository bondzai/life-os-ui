import type { Tracker } from '@/core/types'
import { LocalRepository } from './local-repository'

export class TrackerRepository extends LocalRepository<Tracker> {
  constructor() {
    super('trackers')
  }

  async getByEntityId(entityId: string): Promise<Tracker[]> {
    return this.query((t) => t.entityId === entityId)
  }

  async getByDateRange(start: string, end: string): Promise<Tracker[]> {
    return this.query((t) => t.timestamp >= start && t.timestamp <= end)
  }
}
