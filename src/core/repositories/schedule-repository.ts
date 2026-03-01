import type { Schedule } from '@/core/types'
import { LocalRepository } from './local-repository'

export class ScheduleRepository extends LocalRepository<Schedule> {
  constructor() {
    super('schedules')
  }

  async getByEntityId(entityId: string): Promise<Schedule[]> {
    return this.query((s) => s.entityId === entityId)
  }

  async getActive(): Promise<Schedule[]> {
    return this.query((s) => s.isActive)
  }
}
