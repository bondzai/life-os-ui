import type { Entity } from '@/core/types'

export function duplicateEntity(entity: Entity): Entity {
  return {
    ...entity,
    id: crypto.randomUUID(),
    title: `${entity.title} (copy)`,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
