import type { User, Entity } from '@/core/types'

const KEY_PREFIX = 'life-os:'

const users: User[] = [
  {
    id: 'user-jb',
    name: 'JB',
    role: 'admin',
    pin: '1234',
  },
  {
    id: 'user-wife',
    name: 'Wife',
    role: 'member',
    pin: '5678',
  },
]

const now = new Date().toISOString()

const entities: Entity[] = [
  {
    id: 'entity-1',
    type: 'goal',
    title: 'Run a 5K',
    description: 'Train consistently and complete a 5K run by mid-year.',
    status: 'active',
    priority: 'high',
    tags: ['fitness', 'running'],
    metadata: { targetDistance: 5, unit: 'km' },
    ownerId: 'user-jb',
    visibility: 'private',
    dueDate: '2026-06-30',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'entity-2',
    type: 'goal',
    title: 'Save emergency fund',
    description: 'Build 3-month emergency fund.',
    status: 'active',
    priority: 'high',
    tags: ['finance', 'savings'],
    metadata: { targetAmount: 100000, currency: 'THB' },
    ownerId: 'user-jb',
    visibility: 'shared',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'entity-3',
    type: 'task',
    title: 'Set up Life-OS dashboard',
    description: 'Complete Phase 1 foundation implementation.',
    status: 'active',
    priority: 'urgent',
    tags: ['dev', 'life-os'],
    metadata: {},
    ownerId: 'user-jb',
    visibility: 'private',
    dueDate: '2026-03-15',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'entity-4',
    type: 'task',
    title: 'Grocery shopping',
    description: 'Weekly groceries from the market.',
    status: 'active',
    priority: 'medium',
    tags: ['home', 'errands'],
    metadata: {},
    ownerId: 'user-wife',
    visibility: 'shared',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'entity-5',
    type: 'habit',
    title: 'Morning exercise',
    description: '30 minutes of exercise every morning.',
    status: 'active',
    priority: 'high',
    tags: ['health', 'morning-routine'],
    metadata: { streak: 0, frequency: 'daily' },
    ownerId: 'user-jb',
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'entity-6',
    type: 'habit',
    title: 'Read 30 minutes',
    description: 'Read at least 30 minutes before bed.',
    status: 'active',
    priority: 'medium',
    tags: ['growth', 'reading'],
    metadata: { streak: 0, frequency: 'daily' },
    ownerId: 'user-wife',
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'entity-7',
    type: 'skill',
    title: 'TypeScript',
    description: 'Advance TypeScript proficiency.',
    status: 'active',
    priority: 'medium',
    tags: ['programming', 'web'],
    metadata: { level: 'intermediate' },
    ownerId: 'user-jb',
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  },
]

export function seedIfEmpty(): void {
  if (!localStorage.getItem(`${KEY_PREFIX}users`)) {
    localStorage.setItem(`${KEY_PREFIX}users`, JSON.stringify(users))
  }
  if (!localStorage.getItem(`${KEY_PREFIX}entities`)) {
    localStorage.setItem(`${KEY_PREFIX}entities`, JSON.stringify(entities))
  }
}
