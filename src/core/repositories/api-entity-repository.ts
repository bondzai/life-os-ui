import type { Entity, EntityType } from '@/core/types'
import { ApiRepository } from './api-repository'

export class ApiEntityRepository extends ApiRepository<Entity> {
  constructor() {
    super('entities')
  }

  async getByType(type: EntityType): Promise<Entity[]> {
    const res = await fetch(`${this.baseUrl}/entities?type=${encodeURIComponent(type)}`, {
      headers: this.getHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to fetch entities by type: ${type}`)
    return res.json()
  }

  async getByOwner(ownerId: string): Promise<Entity[]> {
    const res = await fetch(`${this.baseUrl}/entities?ownerId=${ownerId}`, {
      headers: this.getHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to fetch entities by owner: ${ownerId}`)
    return res.json()
  }

  async getChildren(parentId: string): Promise<Entity[]> {
    const res = await fetch(`${this.baseUrl}/entities?parentId=${parentId}`, {
      headers: this.getHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to fetch children of: ${parentId}`)
    return res.json()
  }
}
