import { Hono } from 'hono'
import { db } from '../db/index.js'
import { entities } from '../db/schema.js'
import { eq, and, type SQL } from 'drizzle-orm'

export const entityRoutes = new Hono()

function parseJsonFields(row: any) {
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  }
}

// GET /
entityRoutes.get('/', async (c) => {
  const type = c.req.query('type')
  const ownerId = c.req.query('ownerId')
  const status = c.req.query('status')
  const parentId = c.req.query('parentId')

  const conditions: SQL[] = []
  if (type) conditions.push(eq(entities.type, type))
  if (ownerId) conditions.push(eq(entities.ownerId, ownerId))
  if (status) conditions.push(eq(entities.status, status))
  if (parentId) conditions.push(eq(entities.parentId, parentId))

  let results
  if (conditions.length > 0) {
    results = db.select().from(entities).where(and(...conditions)).all()
  } else {
    results = db.select().from(entities).all()
  }

  return c.json(results.map(parseJsonFields))
})

// GET /:id
entityRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const result = db.select().from(entities).where(eq(entities.id, id)).get()

  if (!result) {
    return c.json({ error: 'Entity not found' }, 404)
  }

  return c.json(parseJsonFields(result))
})

// POST /
entityRoutes.post('/', async (c) => {
  const body = await c.req.json()
  const now = new Date().toISOString()

  const row = {
    id: body.id,
    type: body.type,
    title: body.title,
    description: body.description || null,
    status: body.status || 'active',
    priority: body.priority || 'medium',
    tags: JSON.stringify(body.tags || []),
    metadata: JSON.stringify(body.metadata || {}),
    parentId: body.parentId || null,
    ownerId: body.ownerId || c.get('userId'),
    visibility: body.visibility || 'private',
    dueDate: body.dueDate || null,
    createdAt: body.createdAt || now,
    updatedAt: body.updatedAt || now,
  }

  db.insert(entities).values(row).run()

  return c.json(parseJsonFields(row), 201)
})

// PATCH /:id
entityRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()

  const existing = db.select().from(entities).where(eq(entities.id, id)).get()
  if (!existing) {
    return c.json({ error: 'Entity not found' }, 404)
  }

  const updates: Record<string, any> = { updatedAt: new Date().toISOString() }

  for (const key of ['type', 'title', 'description', 'status', 'priority', 'parentId', 'ownerId', 'visibility', 'dueDate']) {
    if (body[key] !== undefined) updates[key] = body[key]
  }
  if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags)
  if (body.metadata !== undefined) updates.metadata = JSON.stringify(body.metadata)

  db.update(entities).set(updates).where(eq(entities.id, id)).run()

  const updated = db.select().from(entities).where(eq(entities.id, id)).get()
  return c.json(parseJsonFields(updated))
})

// DELETE /:id
entityRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = db.select().from(entities).where(eq(entities.id, id)).get()
  if (!existing) {
    return c.json({ error: 'Entity not found' }, 404)
  }

  db.delete(entities).where(eq(entities.id, id)).run()
  return c.json({ ok: true })
})
