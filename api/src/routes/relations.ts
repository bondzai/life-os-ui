import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index.js'
import { relations } from '../db/schema.js'
import { eq, and, type SQL } from 'drizzle-orm'
import { getUserEntityIds } from '../db/helpers.js'

const createRelationSchema = z.object({
  id: z.string().min(1).max(100),
  fromId: z.string().min(1).max(100),
  toId: z.string().min(1).max(100),
  type: z.string().min(1).max(50),
})

export const relationRoutes = new Hono()

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
  const userId = c.get('userId') as string
  const body = await c.req.json()
  const parsed = createRelationSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, 400)
  }

  const data = parsed.data
  const ownedIds = getUserEntityIds(userId)
  if (!ownedIds.has(data.fromId) && !ownedIds.has(data.toId)) {
    return c.json({ error: 'Relation not found' }, 404)
  }

  const row = {
    id: data.id,
    fromId: data.fromId,
    toId: data.toId,
    type: data.type,
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
