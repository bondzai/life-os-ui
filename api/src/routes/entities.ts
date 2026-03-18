import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index.js'
import { entities } from '../db/schema.js'
import { eq, and, or, type SQL } from 'drizzle-orm'

const createEntitySchema = z.object({
  id: z.string().min(1).max(100),
  type: z.string().min(1).max(50),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional().nullable(),
  status: z.enum(['backlog', 'todo', 'in-progress', 'done', 'archived']).optional().default('todo'),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional().default('medium'),
  tags: z.array(z.string().max(100)).max(50).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  parentId: z.string().max(100).optional().nullable(),
  visibility: z.enum(['private', 'shared']).optional().default('private'),
  dueDate: z.string().max(50).optional().nullable(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

const updateEntitySchema = createEntitySchema.partial().omit({ id: true })

type Env = { Variables: { userId: string; userRole: string } }

export const entityRoutes = new Hono<Env>()

function parseJsonFields(row: any) {
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  }
}

// GET /
entityRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string
  const type = c.req.query('type')
  const status = c.req.query('status')
  const parentId = c.req.query('parentId')

  const conditions: SQL[] = [
    or(eq(entities.ownerId, userId), eq(entities.visibility, 'shared'))!,
  ]
  if (type) conditions.push(eq(entities.type, type))
  if (status) conditions.push(eq(entities.status, status))
  if (parentId) conditions.push(eq(entities.parentId, parentId))

  const results = await db.select().from(entities).where(and(...conditions))

  return c.json(results.map(parseJsonFields))
})

// GET /:id
entityRoutes.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const results = await db.select().from(entities).where(eq(entities.id, id))
  const result = results[0]

  if (!result) {
    return c.json({ error: 'Entity not found' }, 404)
  }

  if (result.ownerId !== userId && result.visibility !== 'shared') {
    return c.json({ error: 'Entity not found' }, 404)
  }

  return c.json(parseJsonFields(result))
})

// POST /
entityRoutes.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = createEntitySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, 400)
  }

  const now = new Date().toISOString()
  const data = parsed.data

  const row = {
    id: data.id,
    type: data.type,
    title: data.title,
    description: data.description || null,
    status: data.status,
    priority: data.priority,
    tags: JSON.stringify(data.tags),
    metadata: JSON.stringify(data.metadata),
    parentId: data.parentId || null,
    ownerId: c.get('userId') as string,
    visibility: data.visibility,
    dueDate: data.dueDate || null,
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now,
  }

  await db.insert(entities).values(row)

  return c.json(parseJsonFields(row), 201)
})

// PATCH /:id
entityRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const body = await c.req.json()

  const existing = (await db.select().from(entities).where(eq(entities.id, id)))[0]
  if (!existing || existing.ownerId !== userId) {
    return c.json({ error: 'Entity not found' }, 404)
  }

  const parsed = updateEntitySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, 400)
  }

  const data = parsed.data
  const updates: Record<string, any> = { updatedAt: new Date().toISOString() }

  for (const key of ['type', 'title', 'description', 'status', 'priority', 'parentId', 'visibility', 'dueDate']) {
    if ((data as any)[key] !== undefined) updates[key] = (data as any)[key]
  }
  if (data.tags !== undefined) updates.tags = JSON.stringify(data.tags)
  if (data.metadata !== undefined) updates.metadata = JSON.stringify(data.metadata)

  await db.update(entities).set(updates).where(eq(entities.id, id))

  const updated = (await db.select().from(entities).where(eq(entities.id, id)))[0]
  return c.json(parseJsonFields(updated))
})

// DELETE /:id
entityRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const existing = (await db.select().from(entities).where(eq(entities.id, id)))[0]
  if (!existing || existing.ownerId !== userId) {
    return c.json({ error: 'Entity not found' }, 404)
  }

  await db.delete(entities).where(eq(entities.id, id))
  return c.json({ ok: true })
})
