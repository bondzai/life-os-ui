import type { Tracker } from '@/core/types'
import { ApiRepository } from './api-repository'

export class ApiTrackerRepository extends ApiRepository<Tracker> {
  constructor() {
    super('trackers')
  }

  async getByEntityId(entityId: string): Promise<Tracker[]> {
    const res = await fetch(`${this.baseUrl}/trackers?entityId=${entityId}`, {
      headers: this.getHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to fetch trackers by entity: ${entityId}`)
    return res.json()
  }

  async getByDateRange(start: string, end: string): Promise<Tracker[]> {
    const res = await fetch(`${this.baseUrl}/trackers?start=${start}&end=${end}`, {
      headers: this.getHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to fetch trackers by date range`)
    return res.json()
  }
}
