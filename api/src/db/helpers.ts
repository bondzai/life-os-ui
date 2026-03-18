import { db } from './index.js'
import { entities } from './schema.js'
import { eq, or } from 'drizzle-orm'

export async function getUserEntityIds(userId: string): Promise<Set<string>> {
  const rows = await db.select({ id: entities.id }).from(entities)
    .where(or(eq(entities.ownerId, userId), eq(entities.visibility, 'shared'))!)
  return new Set(rows.map((r) => r.id))
}
