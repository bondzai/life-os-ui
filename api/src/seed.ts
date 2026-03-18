import bcrypt from 'bcryptjs'
import { db, sqlite } from './db/index.js'
import { users, entities, relations, trackers, schedules } from './db/schema.js'

// Create tables if they don't exist
sqlite.exec(`
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
    status TEXT DEFAULT 'active',
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
sqlite.exec('DELETE FROM trackers; DELETE FROM relations; DELETE FROM schedules; DELETE FROM entities; DELETE FROM users;')

// Seed users (PINs are hashed with bcrypt)
const SALT_ROUNDS = 10
db.insert(users).values([
  { id: 'user-jb', name: 'JB', role: 'admin', pin: bcrypt.hashSync(process.env.SEED_PIN_ADMIN || '1234', SALT_ROUNDS) },
  { id: 'user-sunny', name: 'Sunny', role: 'member', pin: bcrypt.hashSync(process.env.SEED_PIN_MEMBER || '5678', SALT_ROUNDS) },
]).run()

// Seed entities
const entityData = [
  // Goals
  { id: 'goal-1', type: 'goal', title: 'Run a 5K', description: 'Train consistently and complete a 5K run by mid-year.', status: 'active', priority: 'high', tags: JSON.stringify(['fitness', 'running']), metadata: JSON.stringify({ progress: 35 }), ownerId: 'user-jb', visibility: 'private', dueDate: '2026-06-30', createdAt: now, updatedAt: now },
  { id: 'goal-2', type: 'goal', title: 'Save emergency fund', description: 'Build 3-month emergency fund of 100,000 THB.', status: 'active', priority: 'high', tags: JSON.stringify(['finance', 'savings']), metadata: JSON.stringify({ progress: 60 }), ownerId: 'user-jb', visibility: 'shared', dueDate: '2026-12-31', createdAt: now, updatedAt: now },
  { id: 'goal-3', type: 'goal', title: 'Launch Lyra', description: 'Complete all 10 phases of the Lyra project.', status: 'active', priority: 'urgent', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({ progress: 15 }), ownerId: 'user-jb', visibility: 'private', dueDate: '2026-09-30', createdAt: now, updatedAt: now },
  { id: 'goal-4', type: 'goal', title: 'Read 24 books this year', description: 'Read 2 books per month — mix of fiction and non-fiction.', status: 'active', priority: 'medium', tags: JSON.stringify(['growth', 'reading']), metadata: JSON.stringify({ progress: 25 }), ownerId: 'user-sunny', visibility: 'private', dueDate: '2026-12-31', createdAt: now, updatedAt: now },
  { id: 'goal-5', type: 'goal', title: 'Learn Thai cooking', description: 'Master 20 Thai dishes from scratch.', status: 'active', priority: 'low', tags: JSON.stringify(['cooking', 'skills']), metadata: JSON.stringify({ progress: 40 }), ownerId: 'user-sunny', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'goal-3a', type: 'goal', title: 'Complete Phase 1 — Foundation', description: 'Scaffold, core engine, layout, auth, seed data.', status: 'completed', priority: 'urgent', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({ progress: 100 }), parentId: 'goal-3', ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'goal-3b', type: 'goal', title: 'Complete Phase 2 — Plan', description: 'Goals, tasks, calendar modules.', status: 'active', priority: 'urgent', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({ progress: 0 }), parentId: 'goal-3', ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Tasks
  { id: 'task-1', type: 'task', title: 'Set up Lyra dashboard', description: 'Complete Phase 1 foundation implementation.', status: 'completed', priority: 'urgent', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'private', dueDate: yesterday, createdAt: now, updatedAt: now },
  { id: 'task-2', type: 'task', title: 'Grocery shopping', description: 'Weekly groceries from the market.', status: 'active', priority: 'medium', tags: JSON.stringify(['home', 'errands']), metadata: JSON.stringify({}), ownerId: 'user-sunny', visibility: 'shared', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'task-3', type: 'task', title: 'Implement goals page', description: 'Build the goals module with CRUD, sub-goals, and progress tracking.', status: 'active', priority: 'high', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'private', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'task-4', type: 'task', title: 'Implement tasks page', description: 'Build the tasks module with list and kanban views.', status: 'active', priority: 'high', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'private', dueDate: tomorrow, createdAt: now, updatedAt: now },
  { id: 'task-5', type: 'task', title: 'Plan weekend trip', description: 'Research and book a weekend getaway.', status: 'active', priority: 'low', tags: JSON.stringify(['travel', 'fun']), metadata: JSON.stringify({}), ownerId: 'user-sunny', visibility: 'shared', dueDate: nextWeek, createdAt: now, updatedAt: now },
  { id: 'task-6', type: 'task', title: 'Pay electricity bill', description: 'Monthly electricity bill payment.', status: 'active', priority: 'high', tags: JSON.stringify(['home', 'bills']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'shared', dueDate: lastWeek, createdAt: now, updatedAt: now },
  { id: 'task-7', type: 'task', title: 'Review budget spreadsheet', description: 'Monthly budget review and adjustments.', status: 'paused', priority: 'medium', tags: JSON.stringify(['finance']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'private', dueDate: nextMonth, createdAt: now, updatedAt: now },

  // Events
  { id: 'event-1', type: 'event', title: 'Dentist appointment', description: 'Regular 6-month dental check-up.', status: 'active', priority: 'medium', tags: JSON.stringify(['health']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'private', dueDate: tomorrow, createdAt: now, updatedAt: now },
  { id: 'event-2', type: 'event', title: 'Team dinner', description: 'Dinner with the team at the Thai restaurant.', status: 'active', priority: 'low', tags: JSON.stringify(['social']), metadata: JSON.stringify({}), ownerId: 'user-jb', visibility: 'shared', dueDate: nextWeek, createdAt: now, updatedAt: now },
  { id: 'event-3', type: 'event', title: 'Yoga class', description: 'Weekly Saturday morning yoga.', status: 'active', priority: 'medium', tags: JSON.stringify(['health', 'fitness']), metadata: JSON.stringify({}), ownerId: 'user-sunny', visibility: 'private', dueDate: nextWeek, createdAt: now, updatedAt: now },

  // Habits
  { id: 'habit-1', type: 'habit', title: 'Morning exercise', description: '30 minutes of exercise every morning.', status: 'active', priority: 'high', tags: JSON.stringify(['health', 'morning-routine']), metadata: JSON.stringify({ streak: 12, frequency: 'daily' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'habit-2', type: 'habit', title: 'Read 30 minutes', description: 'Read at least 30 minutes before bed.', status: 'active', priority: 'medium', tags: JSON.stringify(['growth', 'reading']), metadata: JSON.stringify({ streak: 5, frequency: 'daily' }), ownerId: 'user-sunny', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'habit-3', type: 'habit', title: 'Meditate', description: '10 minutes of mindfulness meditation.', status: 'active', priority: 'medium', tags: JSON.stringify(['health', 'mindfulness']), metadata: JSON.stringify({ streak: 3, frequency: 'daily' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Skill
  { id: 'skill-1', type: 'skill', title: 'TypeScript', description: 'Advance TypeScript proficiency.', status: 'active', priority: 'medium', tags: JSON.stringify(['programming', 'web']), metadata: JSON.stringify({ level: 'intermediate' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Notes
  { id: 'note-1', type: 'note', title: 'Lyra Architecture Notes', description: 'Key decisions and patterns for the Lyra project.', status: 'active', priority: 'medium', tags: JSON.stringify(['dev', 'lyra']), metadata: JSON.stringify({ body: 'Entity-driven architecture with DRY core engine. All modules reuse the same CRUD hooks and dialog patterns. Zustand for client state, TanStack Query for data sync.', isJournal: false }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'note-2', type: 'note', title: 'Morning reflection', status: 'active', priority: 'low', tags: JSON.stringify(['journal']), metadata: JSON.stringify({ body: 'Feeling productive today. Made good progress on Lyra Phase 4.5. The notification system and map integration are coming together nicely.', isJournal: true, date: today, mood: 'happy' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Posts
  { id: 'post-1', type: 'post', title: 'Post', status: 'active', priority: 'medium', tags: JSON.stringify([]), metadata: JSON.stringify({ body: 'Just deployed Phase 4.5 — notes, places, and travel planning are live!' }), ownerId: 'user-jb', visibility: 'shared', createdAt: twoHoursAgo, updatedAt: twoHoursAgo },
  { id: 'post-2', type: 'post', title: 'Post', status: 'active', priority: 'medium', tags: JSON.stringify([]), metadata: JSON.stringify({ body: 'Added our favorite Chiang Mai spots to the Places module. Weekend trip planning is so much easier now!' }), ownerId: 'user-sunny', visibility: 'shared', createdAt: fiveHoursAgo, updatedAt: fiveHoursAgo },

  // Places
  { id: 'place-1', type: 'place', title: 'Home', description: 'Our home in Bangkok.', status: 'active', priority: 'medium', tags: JSON.stringify(['home', 'bangkok']), metadata: JSON.stringify({ lat: 13.7563, lng: 100.5018, address: 'Bangkok, Thailand' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'place-2', type: 'place', title: 'Chiang Mai Night Bazaar', description: 'Famous night market with food, crafts, and entertainment.', status: 'active', priority: 'low', tags: JSON.stringify(['travel', 'chiang-mai', 'food']), metadata: JSON.stringify({ lat: 18.7871, lng: 98.9936, address: 'Chang Khlan Rd, Chiang Mai' }), ownerId: 'user-sunny', visibility: 'shared', createdAt: now, updatedAt: now },

  // Accounts
  { id: 'account-1', type: 'account', title: 'Bangkok Bank Checking', description: 'Main checking account.', status: 'active', priority: 'medium', tags: JSON.stringify(['banking']), metadata: JSON.stringify({ balance: 45000, accountType: 'checking', currency: 'THB', institution: 'Bangkok Bank' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'account-2', type: 'account', title: 'SCB Savings', description: 'High-interest savings account.', status: 'active', priority: 'medium', tags: JSON.stringify(['banking', 'savings']), metadata: JSON.stringify({ balance: 180000, accountType: 'savings', currency: 'THB', institution: 'SCB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'account-3', type: 'account', title: 'Cash Wallet', description: 'Cash on hand.', status: 'active', priority: 'low', tags: JSON.stringify(['cash']), metadata: JSON.stringify({ balance: 3500, accountType: 'cash', currency: 'THB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Budgets
  { id: 'budget-1', type: 'budget', title: 'Food Budget', status: 'active', priority: 'high', tags: JSON.stringify(['food']), metadata: JSON.stringify({ amount: 15000, category: 'food', period: 'monthly', currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'budget-2', type: 'budget', title: 'Transport Budget', status: 'active', priority: 'medium', tags: JSON.stringify(['transport']), metadata: JSON.stringify({ amount: 5000, category: 'transport', period: 'monthly', currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'budget-3', type: 'budget', title: 'Utilities Budget', status: 'active', priority: 'medium', tags: JSON.stringify(['utilities']), metadata: JSON.stringify({ amount: 4000, category: 'utilities', period: 'monthly', currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'budget-4', type: 'budget', title: 'Entertainment Budget', status: 'active', priority: 'low', tags: JSON.stringify(['entertainment']), metadata: JSON.stringify({ amount: 3000, category: 'entertainment', period: 'monthly', currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'budget-5', type: 'budget', title: 'Shopping Budget', status: 'active', priority: 'medium', tags: JSON.stringify(['shopping']), metadata: JSON.stringify({ amount: 5000, category: 'shopping', period: 'monthly', currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },

  // Transactions
  { id: 'tx-1', type: 'transaction', title: 'Monthly salary', status: 'active', priority: 'medium', tags: JSON.stringify(['income']), metadata: JSON.stringify({ amount: 85000, txType: 'income', category: 'salary', date: today, currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'tx-2', type: 'transaction', title: 'Freelance project', status: 'active', priority: 'medium', tags: JSON.stringify(['income']), metadata: JSON.stringify({ amount: 15000, txType: 'income', category: 'freelance', date: yesterday, currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', dueDate: yesterday, createdAt: now, updatedAt: now },
  { id: 'tx-3', type: 'transaction', title: 'Grocery shopping', status: 'active', priority: 'medium', tags: JSON.stringify(['food']), metadata: JSON.stringify({ amount: 2500, txType: 'expense', category: 'food', date: today, currency: 'THB' }), ownerId: 'user-sunny', visibility: 'shared', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'tx-4', type: 'transaction', title: 'BTS monthly pass', status: 'active', priority: 'medium', tags: JSON.stringify(['transport']), metadata: JSON.stringify({ amount: 1400, txType: 'expense', category: 'transport', date: today, currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'tx-5', type: 'transaction', title: 'Electricity bill', status: 'active', priority: 'medium', tags: JSON.stringify(['utilities']), metadata: JSON.stringify({ amount: 2200, txType: 'expense', category: 'utilities', date: yesterday, currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', dueDate: yesterday, createdAt: now, updatedAt: now },
  { id: 'tx-6', type: 'transaction', title: 'Movie night', status: 'active', priority: 'low', tags: JSON.stringify(['entertainment']), metadata: JSON.stringify({ amount: 800, txType: 'expense', category: 'entertainment', date: yesterday, currency: 'THB' }), ownerId: 'user-sunny', visibility: 'shared', dueDate: yesterday, createdAt: now, updatedAt: now },
  { id: 'tx-7', type: 'transaction', title: 'New headphones', status: 'active', priority: 'low', tags: JSON.stringify(['shopping']), metadata: JSON.stringify({ amount: 3500, txType: 'expense', category: 'shopping', date: lastWeek, currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', dueDate: lastWeek, createdAt: now, updatedAt: now },
  { id: 'tx-8', type: 'transaction', title: 'Dinner at restaurant', status: 'active', priority: 'low', tags: JSON.stringify(['food']), metadata: JSON.stringify({ amount: 1800, txType: 'expense', category: 'food', date: lastWeek, currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', dueDate: lastWeek, createdAt: now, updatedAt: now },
  { id: 'tx-9', type: 'transaction', title: 'Gym membership', status: 'active', priority: 'medium', tags: JSON.stringify(['health']), metadata: JSON.stringify({ amount: 1500, txType: 'expense', category: 'health', date: today, currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'tx-10', type: 'transaction', title: 'Online course', status: 'active', priority: 'medium', tags: JSON.stringify(['education']), metadata: JSON.stringify({ amount: 990, txType: 'expense', category: 'education', date: yesterday, currency: 'THB' }), ownerId: 'user-jb', visibility: 'shared', dueDate: yesterday, createdAt: now, updatedAt: now },

  // Assets
  { id: 'asset-1', type: 'asset', title: 'Bitcoin', status: 'active', priority: 'medium', tags: JSON.stringify(['crypto']), metadata: JSON.stringify({ assetClass: 'crypto', symbol: 'BTC', quantity: 0.25, costBasis: 280000, currentPrice: 350000, chain: 'bitcoin', platform: 'Binance', walletId: 'wallet-1', currency: 'THB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'asset-2', type: 'asset', title: 'Ethereum', status: 'active', priority: 'medium', tags: JSON.stringify(['crypto']), metadata: JSON.stringify({ assetClass: 'crypto', symbol: 'ETH', quantity: 2.0, costBasis: 55000, currentPrice: 62000, chain: 'ethereum', platform: 'Bitkub', walletId: 'wallet-2', currency: 'THB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'asset-3', type: 'asset', title: 'Aave USDC Lending', status: 'active', priority: 'medium', tags: JSON.stringify(['defi']), metadata: JSON.stringify({ assetClass: 'defi', costValue: 150000, currentValue: 158000, chain: 'ethereum', protocol: 'Aave', currency: 'THB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'asset-4', type: 'asset', title: 'SCB SET Index Fund', status: 'active', priority: 'medium', tags: JSON.stringify(['fund']), metadata: JSON.stringify({ assetClass: 'fund', costValue: 100000, currentValue: 108000, platform: 'SCB Securities', currency: 'THB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'asset-5', type: 'asset', title: 'Gold 1 Baht', status: 'active', priority: 'medium', tags: JSON.stringify(['gold']), metadata: JSON.stringify({ assetClass: 'gold', quantity: 1, costBasis: 42000, currentPrice: 44500, currency: 'THB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'asset-6', type: 'asset', title: 'Solana', status: 'active', priority: 'medium', tags: JSON.stringify(['crypto']), metadata: JSON.stringify({ assetClass: 'crypto', symbol: 'SOL', quantity: 50, costBasis: 2800, currentPrice: 3200, chain: 'solana', platform: 'Binance', walletId: 'wallet-1', currency: 'THB' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Wallets
  { id: 'wallet-1', type: 'wallet', title: 'Binance', status: 'active', priority: 'medium', tags: JSON.stringify(['crypto', 'cex']), metadata: JSON.stringify({ walletType: 'cex', platform: 'Binance' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'wallet-2', type: 'wallet', title: 'Bitkub', status: 'active', priority: 'medium', tags: JSON.stringify(['crypto', 'cex']), metadata: JSON.stringify({ walletType: 'cex', platform: 'Bitkub' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'wallet-3', type: 'wallet', title: 'Ledger Nano', status: 'active', priority: 'medium', tags: JSON.stringify(['crypto', 'hardware']), metadata: JSON.stringify({ walletType: 'hardware', chain: 'multi', address: 'bc1q...xyz' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Crypto Transactions
  { id: 'crypto-tx-1', type: 'crypto-tx', title: 'BUY BTC', status: 'active', priority: 'medium', tags: JSON.stringify(['crypto']), metadata: JSON.stringify({ txAction: 'buy', symbol: 'BTC', quantity: 0.25, pricePerUnit: 280000, totalValue: 70000, fee: 150, walletId: 'wallet-1', date: '2025-12-15' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'crypto-tx-2', type: 'crypto-tx', title: 'BUY ETH', status: 'active', priority: 'medium', tags: JSON.stringify(['crypto']), metadata: JSON.stringify({ txAction: 'buy', symbol: 'ETH', quantity: 2.0, pricePerUnit: 55000, totalValue: 110000, fee: 100, walletId: 'wallet-2', date: '2026-01-10' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'crypto-tx-3', type: 'crypto-tx', title: 'TRANSFER-OUT BTC', status: 'active', priority: 'medium', tags: JSON.stringify(['crypto']), metadata: JSON.stringify({ txAction: 'transfer-out', symbol: 'BTC', quantity: 0.1, fee: 50, walletId: 'wallet-1', toWalletId: 'wallet-3', date: '2026-02-01' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'crypto-tx-4', type: 'crypto-tx', title: 'BUY SOL', status: 'active', priority: 'medium', tags: JSON.stringify(['crypto']), metadata: JSON.stringify({ txAction: 'buy', symbol: 'SOL', quantity: 50, pricePerUnit: 2800, totalValue: 140000, fee: 80, walletId: 'wallet-1', date: '2026-01-20' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Body Metrics
  { id: 'bm-1', type: 'body-metric', title: 'Weight — 72.5', status: 'active', priority: 'medium', tags: JSON.stringify(['health']), metadata: JSON.stringify({ metricType: 'weight', value: 72.5, date: lastWeek }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'bm-2', type: 'body-metric', title: 'Weight — 72.0', status: 'active', priority: 'medium', tags: JSON.stringify(['health']), metadata: JSON.stringify({ metricType: 'weight', value: 72.0, date: yesterday }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'bm-3', type: 'body-metric', title: 'Body Fat — 18', status: 'active', priority: 'medium', tags: JSON.stringify(['health']), metadata: JSON.stringify({ metricType: 'body-fat', value: 18, date: yesterday }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'bm-4', type: 'body-metric', title: 'Waist — 80', status: 'active', priority: 'medium', tags: JSON.stringify(['health']), metadata: JSON.stringify({ metricType: 'waist', value: 80, date: today }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Workouts
  { id: 'workout-1', type: 'workout', title: 'Upper body strength', status: 'active', priority: 'medium', tags: JSON.stringify(['strength']), metadata: JSON.stringify({ workoutType: 'strength', duration: 45, calories: 320, exercises: 'Bench 3x10, Rows 3x10, Shoulder press 3x8', date: yesterday }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'workout-2', type: 'workout', title: 'Morning run', status: 'active', priority: 'medium', tags: JSON.stringify(['cardio']), metadata: JSON.stringify({ workoutType: 'cardio', duration: 30, calories: 280, date: today }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'workout-3', type: 'workout', title: 'Yoga flow', status: 'active', priority: 'medium', tags: JSON.stringify(['flexibility']), metadata: JSON.stringify({ workoutType: 'flexibility', duration: 40, calories: 150, date: lastWeek }), ownerId: 'user-sunny', visibility: 'private', createdAt: now, updatedAt: now },

  // Sleep & Mood
  { id: 'sm-1', type: 'sleep-mood', title: '7.5h sleep / good', status: 'active', priority: 'medium', tags: JSON.stringify([]), metadata: JSON.stringify({ sleepHours: 7.5, sleepQuality: 'good', mood: 'good', energy: 7, date: today }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'sm-2', type: 'sleep-mood', title: '6h sleep / okay', status: 'active', priority: 'medium', tags: JSON.stringify([]), metadata: JSON.stringify({ sleepHours: 6, sleepQuality: 'light', mood: 'okay', energy: 5, date: yesterday }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'sm-3', type: 'sleep-mood', title: '8h sleep / great', status: 'active', priority: 'medium', tags: JSON.stringify([]), metadata: JSON.stringify({ sleepHours: 8, sleepQuality: 'deep', mood: 'great', energy: 9, date: lastWeek }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Devices
  { id: 'device-1', type: 'device', title: 'Mini PC (Home Server)', description: 'Main home server running Lyra, OpenClaw, and Docker.', status: 'active', priority: 'high', tags: JSON.stringify(['server', 'docker']), metadata: JSON.stringify({ deviceType: 'server', ip: '192.168.1.100', os: 'Ubuntu 24.04 LTS', location: 'Living room' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'device-2', type: 'device', title: 'MacBook Pro', description: "JB's development laptop.", status: 'active', priority: 'medium', tags: JSON.stringify(['laptop', 'dev']), metadata: JSON.stringify({ deviceType: 'laptop', ip: '192.168.1.101', os: 'macOS Ventura', location: 'Office' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'device-3', type: 'device', title: 'Wi-Fi Router', description: 'Main home router.', status: 'active', priority: 'medium', tags: JSON.stringify(['network']), metadata: JSON.stringify({ deviceType: 'router', ip: '192.168.1.1', location: 'Living room' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },

  // Services
  { id: 'service-1', type: 'service', title: 'Lyra API', status: 'active', priority: 'high', tags: JSON.stringify(['api', 'lyra']), metadata: JSON.stringify({ serviceType: 'api', serviceStatus: 'running', url: 'http://192.168.1.100:3000', port: 3000, deviceId: 'device-1', image: 'lyra-api:latest' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'service-2', type: 'service', title: 'OpenClaw Gateway', status: 'active', priority: 'high', tags: JSON.stringify(['ai', 'gateway']), metadata: JSON.stringify({ serviceType: 'api', serviceStatus: 'running', url: 'http://192.168.1.100:18789', port: 18789, deviceId: 'device-1', image: 'openclaw:latest' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'service-3', type: 'service', title: 'PostgreSQL', status: 'active', priority: 'high', tags: JSON.stringify(['database']), metadata: JSON.stringify({ serviceType: 'database', serviceStatus: 'running', port: 5432, deviceId: 'device-1', image: 'postgres:16' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'service-4', type: 'service', title: 'Portainer', status: 'active', priority: 'medium', tags: JSON.stringify(['monitoring', 'docker']), metadata: JSON.stringify({ serviceType: 'monitoring', serviceStatus: 'running', url: 'http://192.168.1.100:9000', port: 9000, deviceId: 'device-1', image: 'portainer/portainer-ce:latest' }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },

  // Automations
  { id: 'automation-1', type: 'automation', title: 'Weekly Review', description: 'Creates a "Weekly Review" task every Monday.', status: 'active', priority: 'medium', tags: JSON.stringify(['template']), metadata: JSON.stringify({ templateId: 'weekly-review', triggerType: 'schedule', scheduleInterval: 'weekly', actionType: 'create-entity', actionConfig: { entityType: 'task', title: 'Weekly review', tags: ['review'], priority: 'medium' }, enabled: true, runCount: 3, lastRun: lastWeek + 'T09:00:00.000Z', nextDue: tomorrow }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'automation-2', type: 'automation', title: 'Daily Habit Reminder', description: 'Morning notification to complete your daily habits.', status: 'active', priority: 'medium', tags: JSON.stringify(['template']), metadata: JSON.stringify({ templateId: 'daily-habit-reminder', triggerType: 'schedule', scheduleInterval: 'daily', actionType: 'notify', actionConfig: { notifyTitle: 'Habit Check', notifyMessage: "Don't forget to check in on your daily habits!" }, enabled: true, runCount: 14, lastRun: yesterday + 'T08:00:00.000Z', nextDue: today }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },
  { id: 'automation-3', type: 'automation', title: 'Archive completed tasks', description: 'Manually archive all completed tasks at once.', status: 'active', priority: 'medium', tags: JSON.stringify([]), metadata: JSON.stringify({ triggerType: 'manual', actionType: 'update-entities', actionConfig: { targetType: 'task', targetStatus: 'completed', newStatus: 'archived' }, enabled: true, runCount: 1, lastRun: lastWeek + 'T10:00:00.000Z' }), ownerId: 'user-jb', visibility: 'private', createdAt: now, updatedAt: now },

  // Chores
  { id: 'chore-1', type: 'chore', title: 'Vacuum the house', description: 'Vacuum all rooms including under furniture.', status: 'active', priority: 'medium', tags: JSON.stringify(['cleaning']), metadata: JSON.stringify({ category: 'cleaning', frequency: 'weekly', assigneeId: 'user-jb', note: 'Use HEPA filter' }), ownerId: 'user-jb', visibility: 'shared', dueDate: tomorrow, createdAt: now, updatedAt: now },
  { id: 'chore-2', type: 'chore', title: 'Cook dinner', description: 'Prepare dinner for the household.', status: 'active', priority: 'medium', tags: JSON.stringify(['cooking']), metadata: JSON.stringify({ category: 'cooking', frequency: 'daily', assigneeId: 'user-sunny' }), ownerId: 'user-sunny', visibility: 'shared', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'chore-3', type: 'chore', title: 'Do laundry', description: 'Wash, dry, and fold clothes.', status: 'active', priority: 'medium', tags: JSON.stringify(['laundry']), metadata: JSON.stringify({ category: 'laundry', frequency: 'biweekly', assigneeId: 'user-sunny' }), ownerId: 'user-sunny', visibility: 'shared', dueDate: nextWeek, createdAt: now, updatedAt: now },
  { id: 'chore-4', type: 'chore', title: 'Take out trash', description: 'Collect and take out all garbage and recycling.', status: 'active', priority: 'medium', tags: JSON.stringify(['cleaning']), metadata: JSON.stringify({ category: 'cleaning', frequency: 'daily', assigneeId: 'user-jb' }), ownerId: 'user-jb', visibility: 'shared', dueDate: today, createdAt: now, updatedAt: now },
  { id: 'chore-5', type: 'chore', title: 'Weekly grocery run', description: 'Buy groceries for the week from the market.', status: 'active', priority: 'high', tags: JSON.stringify(['shopping']), metadata: JSON.stringify({ category: 'shopping', frequency: 'weekly', assigneeId: 'user-sunny', note: 'Check fridge and pantry before going' }), ownerId: 'user-sunny', visibility: 'shared', dueDate: tomorrow, createdAt: now, updatedAt: now },

  // Memories
  { id: 'memory-1', type: 'memory', title: 'Sunset at Doi Suthep', status: 'active', priority: 'medium', tags: JSON.stringify(['travel', 'chiang-mai']), metadata: JSON.stringify({ imageData: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', thumbnailData: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', caption: 'Golden hour at the temple with an incredible view of the city below.', date: lastWeek, mood: 'peaceful', location: 'Doi Suthep, Chiang Mai', isFavorite: false }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'memory-2', type: 'memory', title: 'Weekend cooking together', status: 'active', priority: 'medium', tags: JSON.stringify(['home', 'cooking']), metadata: JSON.stringify({ imageData: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', thumbnailData: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', caption: 'Made pad thai from scratch for the first time — turned out great!', date: yesterday, mood: 'joyful', location: 'Home, Bangkok', isFavorite: false }), ownerId: 'user-sunny', visibility: 'shared', createdAt: now, updatedAt: now },
  { id: 'memory-3', type: 'memory', title: 'Morning at Lumpini Park', status: 'active', priority: 'medium', tags: JSON.stringify(['exercise', 'bangkok']), metadata: JSON.stringify({ imageData: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', thumbnailData: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', caption: 'Early morning jog with the monitor lizards.', date: today, mood: 'grateful', location: 'Lumpini Park, Bangkok', isFavorite: false }), ownerId: 'user-jb', visibility: 'shared', createdAt: now, updatedAt: now },

  // Trips
  { id: 'trip-1', type: 'trip', title: 'Chiang Mai Weekend', description: 'Quick weekend getaway to explore Chiang Mai.', status: 'active', priority: 'medium', tags: JSON.stringify(['travel', 'weekend']), metadata: JSON.stringify({ endDate: nextWeek }), ownerId: 'user-jb', visibility: 'shared', dueDate: tomorrow, createdAt: now, updatedAt: now },
]

// Insert entities in batches (SQLite has a variable limit)
const BATCH_SIZE = 20
for (let i = 0; i < entityData.length; i += BATCH_SIZE) {
  const batch = entityData.slice(i, i + BATCH_SIZE)
  db.insert(entities).values(batch).run()
}

// Seed relations
db.insert(relations).values([
  { id: 'rel-1', fromId: 'goal-3', toId: 'goal-3a', type: 'parent' },
  { id: 'rel-2', fromId: 'goal-3', toId: 'goal-3b', type: 'parent' },
  { id: 'rel-3', fromId: 'trip-1', toId: 'place-2', type: 'relates' },
]).run()

// Seed trackers
db.insert(trackers).values([
  { id: 'tracker-1', entityId: 'habit-1', value: 1, unit: 'done', note: 'Morning run completed', timestamp: new Date().toISOString(), ownerId: 'user-jb' },
  { id: 'tracker-2', entityId: 'habit-3', value: 1, unit: 'done', timestamp: new Date().toISOString(), ownerId: 'user-jb' },
]).run()

console.log('Database seeded successfully!')
console.log(`  - ${2} users`)
console.log(`  - ${entityData.length} entities`)
console.log(`  - ${3} relations`)
console.log(`  - ${2} trackers`)

sqlite.close()
