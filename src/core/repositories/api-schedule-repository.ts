import type { Schedule } from '@/core/types'
import { ApiRepository } from './api-repository'

export class ApiScheduleRepository extends ApiRepository<Schedule> {
  constructor() {
    super('schedules')
  }

  async getByEntityId(entityId: string): Promise<Schedule[]> {
    const res = await fetch(`${this.baseUrl}/schedules?entityId=${entityId}`, {
      headers: this.getHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to fetch schedules by entity: ${entityId}`)
    return res.json()
  }

  async getActive(): Promise<Schedule[]> {
    const res = await fetch(`${this.baseUrl}/schedules?active=true`, {
      headers: this.getHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to fetch active schedules`)
    return res.json()
  }
}
