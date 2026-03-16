import { Hono } from 'hono'
import { db } from '../db/index.js'
import { relations, entities } from '../db/schema.js'
import { eq, and, or, type SQL } from 'drizzle-orm'

export const relationRoutes = new Hono()

/** Get entity IDs the user owns or has shared access to */
function getUserEntityIds(userId: string): Set<string> {
  const rows = db.select({ id: entities.id }).from(entities)
    .where(or(eq(entities.ownerId, userId), eq(entities.visibility, 'shared'))!)
    .all()
  return new Set(rows.map((r) => r.id))
}

// GET /
relationRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string
  const fromId = c.req.query('fromId')
  const toId = c.req.query('toId')

  const conditions: SQL[] = []
  if (fromId) conditions.push(eq(relations.fromId, fromId))
  if (toId) conditions.push(eq(relations.toId, toId))

  let results
  if (conditions.length > 0) {
    results = db.select().from(relations).where(and(...conditions)).all()
  } else {
    results = db.select().from(relations).all()
  }

  const ownedIds = getUserEntityIds(userId)
  return c.json(results.filter((r) => ownedIds.has(r.fromId!) || ownedIds.has(r.toId!)))
})

// GET /:id
relationRoutes.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const result = db.select().from(relations).where(eq(relations.id, id)).get()

  if (!result) return c.json({ error: 'Relation not found' }, 404)

  const ownedIds = getUserEntityIds(userId)
  if (!ownedIds.has(result.fromId!) && !ownedIds.has(result.toId!)) {
    return c.json({ error: 'Relation not found' }, 404)
  }

  return c.json(result)
})

// POST /
relationRoutes.post('/', async (c) => {
  const body = await c.req.json()

  const row = {
    id: body.id,
    fromId: body.fromId,
    toId: body.toId,
    type: body.type,
  }

  db.insert(relations).values(row).run()

  return c.json(row, 201)
})

// DELETE /:id
relationRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const existing = db.select().from(relations).where(eq(relations.id, id)).get()
  if (!existing) return c.json({ error: 'Relation not found' }, 404)

  const ownedIds = getUserEntityIds(userId)
  if (!ownedIds.has(existing.fromId!) && !ownedIds.has(existing.toId!)) {
    return c.json({ error: 'Relation not found' }, 404)
  }

  db.delete(relations).where(eq(relations.id, id)).run()
  return c.json({ ok: true })
})
