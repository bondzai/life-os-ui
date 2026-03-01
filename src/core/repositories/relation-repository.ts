import type { Relation } from '@/core/types'
import { LocalRepository } from './local-repository'

export class RelationRepository extends LocalRepository<Relation> {
  constructor() {
    super('relations')
  }

  async getByFromId(fromId: string): Promise<Relation[]> {
    return this.query((r) => r.fromId === fromId)
  }

  async getByToId(toId: string): Promise<Relation[]> {
    return this.query((r) => r.toId === toId)
  }
}
