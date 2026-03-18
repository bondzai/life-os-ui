import { db } from './index.js'
import { entities } from './schema.js'
import { eq, or } from 'drizzle-orm'

export function getUserEntityIds(userId: string): Set<string> {
  const rows = db.select({ id: entities.id }).from(entities)
    .where(or(eq(entities.ownerId, userId), eq(entities.visibility, 'shared'))!)
    .all()
  return new Set(rows.map((r) => r.id))
}
