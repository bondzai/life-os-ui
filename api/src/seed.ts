import bcrypt from 'bcryptjs'
import { db, client } from './db/index.js'
import { users, entities, relations, trackers } from './db/schema.js'

// Create tables if they don't exist
await client.executeMultiple(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    role TEXT,
    pin TEXT,
    avatarUrl TEXT
  );

  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    type TEXT,
    title TEXT,
    description TEXT,
    status TEXT DEFAULT 'todo',
    priority TEXT DEFAULT 'medium',
    tags TEXT,
    metadata TEXT,
    parentId TEXT,
    ownerId TEXT,
    visibility TEXT DEFAULT 'private',
    dueDate TEXT,
    createdAt TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS trackers (
    id TEXT PRIMARY KEY,
    entityId TEXT,
    value REAL,
    unit TEXT,
    note TEXT,
    timestamp TEXT,
    ownerId TEXT
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    entityId TEXT,
    recurrence TEXT,
    nextDue TEXT,
    lastCompleted TEXT,
    isActive INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    fromId TEXT,
    toId TEXT,
    type TEXT
  );

  CREATE TABLE IF NOT EXISTS google_tokens (
    userId TEXT PRIMARY KEY,
    accessToken TEXT,
    refreshToken TEXT,
    expiresAt TEXT,
    calendarId TEXT
  );
`)

// Date helpers
const now = new Date().toISOString()
const today = new Date().toISOString().split('T')[0]
const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]
const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]
const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString()
const fiveHoursAgo = new Date(Date.now() - 5 * 3600000).toISOString()

// Clear existing data
await client.executeMultiple('DELETE FROM trackers; DELETE FROM relations; DELETE FROM schedules; DELETE FROM entities; DELETE FROM users;')

// Seed users (PINs are hashed with bcrypt)
const SALT_ROUNDS = 10
await db.insert(users).values([
  { id: 'user-jb', name: 'JB', role: 'admin', pin: bcrypt.hashSync(process.env.SEED_PIN_ADMIN || '1234', SALT_ROUNDS) },
  { id: 'user-sunny', name: 'Sunny', role: 'member', pin: bcrypt.hashSync(process.env.SEED_PIN_MEMBER || '5678', SALT_ROUNDS) },
])

// Seed entities
const entityData = [
  // Goals
  { id: 'goal-1', type: 'goal', title: 'Run a 5K', description: 'Train consistently and complete a 5K run by mid-year.', status: 'todo', priority: 'high', tags: JSON.stringify(['fitness', 'running']), metadata: JSON.stringify({ progress: 35 }), ownerId: 'user-jb', visibility: 'private', dueDate: '2026-06-30', createdAt: now, updatedAt: now },
  { id: 'goal-2', type: 'goal', title: 'Save emergency fund', description: 'Build 3-month emergency fund of 100,000 THB.', status: 'todo', priority: 'high', tags: JSON.stringify(['finance', 'savings']), metadata: JSON.stringify({ progress: 60 }), ownerId: 'user-jb', visibility: 'shared', dueDate: '2026-12-31', createdAt: now, updatedAt: now },
  { id: 'goal-3', type: 'goal', title: 'Launch Lyra', description: 'Complete all 10 phases of the Lyra project.', status: 'todo', priority: 'urgent', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({ progress: 15 }), ownerId: 'user-jb', visibility: 'private', dueDate: '2026-09-30', createdAt: now, updatedAt: now },
  { id: 'goal-4', type: 'goal', title: 'Read 24 books this year', description: 'Read 2 books per month — mix of fiction and non-fiction.', status: 'todo', priority: 'medium', tags: JSON.stringify(['growth', 'reading']), metadata: JSON.stringify({ progress: 25 }), ownerId: 'user-sunny', visibility: 'private', dueDate: '2026-12-31', createdAt: now, updatedAt: now },
  { id: 'goal-5', type: 'goal', title: 'Learn Thai cooking', description: 'Master 20 Thai dishes from scratch.', status: 'todo', priority: 'low', tags: JSON.stringify(['cooking', 'skills']), metadata: JSON.stringify({ progress: 40 }), ownerId: 'user-sunny', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'goal-3a', type: 'goal', title: 'Complete Phase 1 — Foundation', description: 'Scaffold, core engine, layout, auth, seed data.', status: 'done', priority: 'urgent', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({ progress: 100 }), parentId: 'goal-3', ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'goal-3b', type: 'goal', title: 'Complete Phase 2 — Plan', description: 'Goals, tasks, calendar modules.', status: 'todo', priority: 'urgent', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({ progress: 0 }), parentId: 'goal-3', ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Tasks
  { id: 'task-1', type: 'task', title: 'Set up Lyra dashboard', description: 'Complete Phase 1 foundation implementation.', status: 'done', priority: 'urgent', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'private', dueDate: yesterday, createdAt: now, updatedAt: now },
  { id: 'task-2', type: 'task', title: 'Grocery shopping', description: 'Weekly groceries from the market.', status: 'todo', priority: 'medium', tags: JSON.stringify(['home', 'errands']), metadata: JSON.stringify({}), ownerId: 'user-sunny', visibility: 'shared', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'task-3', type: 'task', title: 'Implement goals page', description: 'Build the goals module with CRUD, sub-goals, and progress tracking.', status: 'todo', priority: 'high', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'private', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'task-4', type: 'task', title: 'Implement tasks page', description: 'Build the tasks module with list and kanban views.', status: 'todo', priority: 'high', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'private', dueDate: tomorrow, createdAt: now, updatedAt: now },
  { id: 'task-5', type: 'task', title: 'Plan weekend trip', description: 'Research and book a weekend getaway.', status: 'todo', priority: 'low', tags: JSON.stringify(['travel', 'fun']), metadata: JSON.stringify({}), ownerId: 'user-sunny', visibility: 'shared', dueDate: nextWeek, createdAt: now, updatedAt: now },
  { id: 'task-6', type: 'task', title: 'Pay electricity bill', description: 'Monthly electricity bill payment.', status: 'todo', priority: 'high', tags: JSON.stringify(['home', 'bills']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'shared', dueDate: lastWeek, createdAt: now, updatedAt: now },
  { id: 'task-7', type: 'task', title: 'Review budget spreadsheet', description: 'Monthly budget review and adjustments.', status: 'in-progress', priority: 'medium', tags: JSON.stringify(['finance']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'private', dueDate: nextMonth, createdAt: now, updatedAt: now },

  // Events
  { id: 'event-1', type: 'event', title: 'Dentist appointment', description: 'Regular 6-month dental check-up.', status: 'todo', priority: 'medium', tags: JSON.stringify(['health']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'private', dueDate: tomorrow, createdAt: now, updatedAt: now },
  { id: 'event-2', type: 'event', title: 'Team dinner', description: 'Dinner with the team at the Thai restaurant.', status: 'todo', priority: 'low', tags: JSON.stringify(['social']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'shared', dueDate: nextWeek, createdAt: now, updatedAt: now },
  { id: 'event-3', type: 'event', title: 'Yoga class', description: 'Weekly Saturday morning yoga.', status: 'todo', priority: 'medium', tags: JSON.stringify(['health', 'fitness']), metadata: JSON.stringify({}), ownerId: 'user-sunny', visibility: 'private', dueDate: nextWeek, createdAt: now, updatedAt: now },

  // Habits
  { id: 'habit-1', type: 'habit', title: 'Morning exercise', description: '30 minutes of exercise every morning.', status: 'todo', priority: 'high', tags: JSON.stringify(['health', 'morning-routine']), metadata: JSON.stringify({ streak: 12, frequency: 'daily' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'habit-2', type: 'habit', title: 'Read 30 minutes', description: 'Read at least 30 minutes before bed.', status: 'todo', priority: 'medium', tags: JSON.stringify(['growth', 'reading']), metadata: JSON.stringify({ streak: 5, frequency: 'daily' }), ownerId: 'user-sunny', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'habit-3', type: 'habit', title: 'Meditate', description: '10 minutes of mindfulness meditation.', status: 'todo', priority: 'medium', tags: JSON.stringify(['health', 'mindfulness']), metadata: JSON.stringify({ streak: 3, frequency: 'daily' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Skill
  { id: 'skill-1', type: 'skill', title: 'TypeScript', description: 'Advance TypeScript proficiency.', status: 'todo', priority: 'medium', tags: JSON.stringify(['programming', 'web']), metadata: JSON.stringify({ level: 'intermediate' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Notes
  { id: 'note-1', type: 'note', title: 'Lyra Architecture Notes', description: 'Key decisions and patterns for the Lyra project.', status: 'todo', priority: 'medium', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({ body: 'Entity-driven architecture with DRY core engine. All modules reuse the same CRUD hooks and dialog patterns. Zustand for client state, TanStack Query for data sync.', isJournal: false }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'note-2', type: 'note', title: 'Morning reflection', status: 'todo', priority: 'low', tags: JSON.stringify(['journal']), metadata: JSON.stringify({ body: 'Feeling productive today. Made good progress on Lyra Phase 4.5. The notification system and map integration are coming together nicely.', isJournal: true, date: today, mood: 'happy' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Posts
  { id: 'post-1', type: 'post', title: 'Post', status: 'todo', priority: 'medium', tags: JSON.stringify([]), metadata: JSON.stringify({ body: 'Just deployed Phase 4.5 — notes, places, and travel planning are live!' }), ownerId: 'user-jb', visibility: 'shared', createdAt: twoHoursAgo, updatedAt: twoHoursAgo },
  { id: 'post-2', type: 'post', title: 'Post', status: 'todo', priority: 'medium', tags: JSON.stringify([]), metadata: JSON.stringify({ body: 'Added our favorite Chiang Mai spots to the Places module. Weekend trip planning is so much easier now!' }), ownerId: 'user-sunny', visibility: 'shared', createdAt: fiveHoursAgo, updatedAt: fiveHoursAgo },

  // Places
  { id: 'place-1', type: 'place', title: 'Home', description: 'Our home in Bangkok.', status: 'todo', priority: 'medium', tags: JSON.stringify(['home', 'bangkok']), metadata: JSON.stringify({ lat: 13.7563, lng: 100.5018, address: 'Bangkok, Thailand' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'place-2', type: 'place', title: 'Chiang Mai Night Bazaar', description: 'Famous night market with food, crafts, and entertainment.', status: 'todo', priority: 'low', tags: JSON.stringify(['travel', 'chiang-mai', 'food']), metadata: JSON.stringify({ lat: 18.7871, lng: 98.9936, address: 'Chang Khlan Rd, Chiang Mai' }), ownerId: 'user-sunny', visibility: 'shared', createdAt: now, updatedAt: now },

  // Accounts
  { id: 'account-1', type: 'account', title: 'Bangkok Bank Checking', description: 'Main checking account.', status: 'todo', priority: 'medium', tags: JSON.stringify(['banking']), metadata: JSON.stringify({ balance: 45000, accountType: 'checking', currency: 'THB', institution: 'Bangkok Bank' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'account-2', type: 'account', title: 'SCB Savings', description: 'High-interest savings account.', status: 'todo', priority: 'medium', tags: JSON.stringify(['banking', 'savings']), metadata: JSON.stringify({ balance: 180000, accountType: 'savings', currency: 'THB', institution: 'SCB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'account-3', type: 'account', title: 'Cash Wallet', description: 'Cash on hand.', status: 'todo', priority: 'low', tags: JSON.stringify(['cash']), metadata: JSON.stringify({ balance: 3500, accountType: 'cash', currency: 'THB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Budgets
  { id: 'budget-1', type: 'budget', title: 'Food Budget', status: 'todo', priority: 'high', tags: JSON.stringify(['food']), metadata: JSON.stringify({ amount: 15000, category: 'food', period: 'monthly', currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'budget-2', type: 'budget', title: 'Transport Budget', status: 'todo', priority: 'medium', tags: JSON.stringify(['transport']), metadata: JSON.stringify({ amount: 5000, category: 'transport', period: 'monthly', currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'budget-3', type: 'budget', title: 'Utilities Budget', status: 'todo', priority: 'medium', tags: JSON.stringify(['utilities']), metadata: JSON.stringify({ amount: 4000, category: 'utilities', period: 'monthly', currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'budget-4', type: 'budget', title: 'Entertainment Budget', status: 'todo', priority: 'low', tags: JSON.stringify(['entertainment']), metadata: JSON.stringify({ amount: 3000, category: 'entertainment', period: 'monthly', currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'budget-5', type: 'budget', title: 'Shopping Budget', status: 'todo', priority: 'medium', tags: JSON.stringify(['shopping']), metadata: JSON.stringify({ amount: 5000, category: 'shopping', period: 'monthly', currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },

  // Transactions
  { id: 'tx-1', type: 'transaction', title: 'Monthly salary', status: 'todo', priority: 'medium', tags: JSON.stringify(['income']), metadata: JSON.stringify({ amount: 85000, txType: 'income', category: 'salary', date: today, currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'tx-2', type: 'transaction', title: 'Freelance project', status: 'todo', priority: 'medium', tags: JSON.stringify(['income']), metadata: JSON.stringify({ amount: 15000, txType: 'income', category: 'freelance', date: yesterday, currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', dueDate: yesterday, createdAt: now, updatedAt: now },

  // Assets
  { id: 'asset-1', type: 'asset', title: 'Bitcoin', status: 'todo', priority: 'medium', tags: JSON.stringify(['crypto']), metadata: JSON.stringify({ assetClass: 'crypto', symbol: 'BTC', quantity: 0.25, costBasis: 280000, currentPrice: 350000, chain: 'bitcoin', platform: 'Binance', walletId: 'wallet-1', currency: 'THB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Chores
  { id: 'chore-1', type: 'chore', title: 'Vacuum the house', description: 'Vacuum all rooms including under furniture.', status: 'todo', priority: 'medium', tags: JSON.stringify(['cleaning']), metadata: JSON.stringify({ category: 'cleaning', frequency: 'weekly', assigneeId: 'user-jb', note: 'Use HEPA filter' }), ownerId: 'user-jb', visibility: 'shared', dueDate: tomorrow, createdAt: now, updatedAt: now },
  { id: 'chore-2', type: 'chore', title: 'Cook dinner', description: 'Prepare dinner for the household.', status: 'todo', priority: 'medium', tags: JSON.stringify(['cooking']), metadata: JSON.stringify({ category: 'cooking', frequency: 'daily', assigneeId: 'user-sunny' }), ownerId: 'user-sunny', visibility: 'shared', dueDate: today, createdAt: now, updatedAt: now },

  // Automations
  { id: 'automation-1', type: 'automation', title: 'Weekly Review', description: 'Creates a "Weekly Review" task every Monday.', status: 'todo', priority: 'medium', tags: JSON.stringify(['template']), metadata: JSON.stringify({ templateId: 'weekly-review', triggerType: 'schedule', scheduleInterval: 'weekly', actionType: 'create-entity', actionConfig: { entityType: 'task', title: 'Weekly review', tags: ['review'], priority: 'medium' }, enabled: true, runCount: 3, lastRun: lastWeek + 'T09:00:00.000Z', nextDue: tomorrow }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'automation-3', type: 'automation', title: 'Archive completed tasks', description: 'Manually archive all completed tasks at once.', status: 'todo', priority: 'medium', tags: JSON.stringify([]), metadata: JSON.stringify({ triggerType: 'manual', actionType: 'update-entities', actionConfig: { targetType: 'task', targetStatus: 'done', newStatus: 'archived' }, enabled: true, runCount: 1, lastRun: lastWeek + 'T10:00:00.000Z' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Trip
  { id: 'trip-1', type: 'trip', title: 'Chiang Mai Weekend', description: 'Quick weekend getaway to explore Chiang Mai.', status: 'todo', priority: 'medium', tags: JSON.stringify(['travel', 'weekend']), metadata: JSON.stringify({ endDate: nextWeek }), ownerId: 'user-jb', visibility: 'shared', dueDate: tomorrow, createdAt: now, updatedAt: now },
]

// Insert entities in batches
const BATCH_SIZE = 20
for (let i = 0; i < entityData.length; i += BATCH_SIZE) {
  const batch = entityData.slice(i, i + BATCH_SIZE)
  await db.insert(entities).values(batch)
}

// Seed relations
await db.insert(relations).values([
  { id: 'rel-1', fromId: 'goal-3', toId: 'goal-3a', type: 'parent' },
  { id: 'rel-2', fromId: 'goal-3', toId: 'goal-3b', type: 'parent' },
  { id: 'rel-3', fromId: 'trip-1', toId: 'place-2', type: 'relates' },
])

// Seed trackers
await db.insert(trackers).values([
  { id: 'tracker-1', entityId: 'habit-1', value: 1, unit: 'done', note: 'Morning run completed', timestamp: new Date().toISOString(), ownerId: 'user-jb' },
  { id: 'tracker-2', entityId: 'habit-3', value: 1, unit: 'done', timestamp: new Date().toISOString(), ownerId: 'user-jb' },
])

console.log('Database seeded successfully!')
console.log(`  - ${2} users`)
console.log(`  - ${entityData.length} entities`)
console.log(`  - ${3} relations`)
console.log(`  - ${2} trackers`)

client.close()
