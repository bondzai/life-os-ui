import type { Relation } from '@/core/types'
import { ApiRepository } from './api-repository'

export class ApiRelationRepository extends ApiRepository<Relation> {
  constructor() {
    super('relations')
  }

  async getByFromId(fromId: string): Promise<Relation[]> {
    const res = await fetch(`${this.baseUrl}/relations?fromId=${fromId}`, {
      headers: this.getHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to fetch relations from: ${fromId}`)
    return res.json()
  }

  async getByToId(toId: string): Promise<Relation[]> {
    const res = await fetch(`${this.baseUrl}/relations?toId=${toId}`, {
      headers: this.getHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to fetch relations to: ${toId}`)
    return res.json()
  }
}
