import type { Entity, EntityType } from '@/core/types'
import { LocalRepository } from './local-repository'

export class EntityRepository extends LocalRepository<Entity> {
  constructor() {
    super('entities')
  }

  async getByType(type: EntityType): Promise<Entity[]> {
    return this.query((e) => e.type === type)
  }

  async getByOwner(ownerId: string): Promise<Entity[]> {
    return this.query((e) => e.ownerId === ownerId)
  }

  async getChildren(parentId: string): Promise<Entity[]> {
    return this.query((e) => e.parentId === parentId)
  }
}
