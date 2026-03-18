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

type Env = { Variables: { userId: string; userRole: string } }

export const relationRoutes = new Hono<Env>()

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
    results = await db.select().from(relations).where(and(...conditions))
  } else {
    results = await db.select().from(relations)
  }

  const ownedIds = await getUserEntityIds(userId)
  return c.json(results.filter((r) => ownedIds.has(r.fromId!) || ownedIds.has(r.toId!)))
})

// GET /:id
relationRoutes.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const result = (await db.select().from(relations).where(eq(relations.id, id)))[0]

  if (!result) return c.json({ error: 'Relation not found' }, 404)

  const ownedIds = await getUserEntityIds(userId)
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
  const ownedIds = await getUserEntityIds(userId)
  if (!ownedIds.has(data.fromId) && !ownedIds.has(data.toId)) {
    return c.json({ error: 'Relation not found' }, 404)
  }

  const row = {
    id: data.id,
    fromId: data.fromId,
    toId: data.toId,
    type: data.type,
  }

  await db.insert(relations).values(row)

  return c.json(row, 201)
})

// DELETE /:id
relationRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const existing = (await db.select().from(relations).where(eq(relations.id, id)))[0]
  if (!existing) return c.json({ error: 'Relation not found' }, 404)

  const ownedIds = await getUserEntityIds(userId)
  if (!ownedIds.has(existing.fromId!) && !ownedIds.has(existing.toId!)) {
    return c.json({ error: 'Relation not found' }, 404)
  }

  await db.delete(relations).where(eq(relations.id, id))
  return c.json({ ok: true })
})
