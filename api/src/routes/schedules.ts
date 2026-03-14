import { Hono } from 'hono'
import { db } from '../db/index.js'
import { schedules } from '../db/schema.js'
import { eq, and, type SQL } from 'drizzle-orm'

export const scheduleRoutes = new Hono()

function parseSchedule(row: any) {
  return {
    ...row,
    isActive: row.isActive === 1,
  }
}

// GET /
scheduleRoutes.get('/', async (c) => {
  const entityId = c.req.query('entityId')
  const isActive = c.req.query('isActive')

  const conditions: SQL[] = []
  if (entityId) conditions.push(eq(schedules.entityId, entityId))
  if (isActive !== undefined) conditions.push(eq(schedules.isActive, isActive === 'true' ? 1 : 0))

  let results
  if (conditions.length > 0) {
    results = db.select().from(schedules).where(and(...conditions)).all()
  } else {
    results = db.select().from(schedules).all()
  }

  return c.json(results.map(parseSchedule))
})

// GET /:id
scheduleRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const result = db.select().from(schedules).where(eq(schedules.id, id)).get()

  if (!result) {
    return c.json({ error: 'Schedule not found' }, 404)
  }

  return c.json(parseSchedule(result))
})

// POST /
scheduleRoutes.post('/', async (c) => {
  const body = await c.req.json()

  const row = {
    id: body.id,
    entityId: body.entityId,
    recurrence: body.recurrence || null,
    nextDue: body.nextDue || null,
    lastCompleted: body.lastCompleted || null,
    isActive: body.isActive === false ? 0 : 1,
  }

  db.insert(schedules).values(row).run()

  return c.json(parseSchedule(row), 201)
})

// PATCH /:id
scheduleRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()

  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get()
  if (!existing) {
    return c.json({ error: 'Schedule not found' }, 404)
  }

  const updates: Record<string, any> = {}
  for (const key of ['entityId', 'recurrence', 'nextDue', 'lastCompleted']) {
    if (body[key] !== undefined) updates[key] = body[key]
  }
  if (body.isActive !== undefined) updates.isActive = body.isActive ? 1 : 0

  db.update(schedules).set(updates).where(eq(schedules.id, id)).run()

  const updated = db.select().from(schedules).where(eq(schedules.id, id)).get()
  return c.json(parseSchedule(updated))
})

// DELETE /:id
scheduleRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get()
  if (!existing) {
    return c.json({ error: 'Schedule not found' }, 404)
  }

  db.delete(schedules).where(eq(schedules.id, id)).run()
  return c.json({ ok: true })
})
