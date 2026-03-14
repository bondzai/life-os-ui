import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name'),
  role: text('role'),
  pin: text('pin'),
  avatarUrl: text('avatarUrl'),
})

export const entities = sqliteTable('entities', {
  id: text('id').primaryKey(),
  type: text('type'),
  title: text('title'),
  description: text('description'),
  status: text('status').default('active'),
  priority: text('priority').default('medium'),
  tags: text('tags'), // JSON array
  metadata: text('metadata'), // JSON object
  parentId: text('parentId'),
  ownerId: text('ownerId'),
  visibility: text('visibility').default('private'),
  dueDate: text('dueDate'),
  createdAt: text('createdAt'),
  updatedAt: text('updatedAt'),
})

export const trackers = sqliteTable('trackers', {
  id: text('id').primaryKey(),
  entityId: text('entityId'),
  value: real('value'),
  unit: text('unit'),
  note: text('note'),
  timestamp: text('timestamp'),
  ownerId: text('ownerId'),
})

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  entityId: text('entityId'),
  recurrence: text('recurrence'),
  nextDue: text('nextDue'),
  lastCompleted: text('lastCompleted'),
  isActive: integer('isActive').default(1),
})

export const relations = sqliteTable('relations', {
  id: text('id').primaryKey(),
  fromId: text('fromId'),
  toId: text('toId'),
  type: text('type'),
})
