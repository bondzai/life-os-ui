import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index.js'
import { trackers } from '../db/schema.js'
import { eq, and, gte, lte, type SQL } from 'drizzle-orm'

const createTrackerSchema = z.object({
  id: z.string().min(1).max(100),
  entityId: z.string().min(1).max(100),
  value: z.number(),
  unit: z.string().max(50).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
  timestamp: z.string().max(50).optional(),
})

export const trackerRoutes = new Hono()

// GET /
trackerRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string
  const entityId = c.req.query('entityId')
  const start = c.req.query('start')
  const end = c.req.query('end')

  const conditions: SQL[] = [eq(trackers.ownerId, userId)]
  if (entityId) conditions.push(eq(trackers.entityId, entityId))
  if (start) conditions.push(gte(trackers.timestamp, start))
  if (end) conditions.push(lte(trackers.timestamp, end))

  const results = db.select().from(trackers).where(and(...conditions)).all()

  return c.json(results)
})

// GET /:id
trackerRoutes.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const result = db.select().from(trackers).where(eq(trackers.id, id)).get()

  if (!result || result.ownerId !== userId) {
    return c.json({ error: 'Tracker not found' }, 404)
  }

  return c.json(result)
})

// POST /
trackerRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json()
  const parsed = createTrackerSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, 400)
  }

  const data = parsed.data
  const row = {
    id: data.id,
    entityId: data.entityId,
    value: data.value,
    unit: data.unit || null,
    note: data.note || null,
    timestamp: data.timestamp || new Date().toISOString(),
    ownerId: userId,
  }

  db.insert(trackers).values(row).run()

  return c.json(row, 201)
})

// PATCH /:id
trackerRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const body = await c.req.json()

  const existing = db.select().from(trackers).where(eq(trackers.id, id)).get()
  if (!existing || existing.ownerId !== userId) {
    return c.json({ error: 'Tracker not found' }, 404)
  }

  const updates: Record<string, any> = {}
  for (const key of ['entityId', 'value', 'unit', 'note', 'timestamp']) {
    if (body[key] !== undefined) updates[key] = body[key]
  }

  db.update(trackers).set(updates).where(eq(trackers.id, id)).run()

  const updated = db.select().from(trackers).where(eq(trackers.id, id)).get()
  return c.json(updated)
})

// DELETE /:id
trackerRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const existing = db.select().from(trackers).where(eq(trackers.id, id)).get()
  if (!existing || existing.ownerId !== userId) {
    return c.json({ error: 'Tracker not found' }, 404)
  }

  db.delete(trackers).where(eq(trackers.id, id)).run()
  return c.json({ ok: true })
})
