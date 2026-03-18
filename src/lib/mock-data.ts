/**
 * Generate realistic mock data for demo/portfolio mode.
 * Populates localStorage with entities, trackers, and health profile.
 */

const uid = () => crypto.randomUUID()
const now = new Date().toISOString()
const today = new Date().toISOString().split('T')[0]

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}

function daysFromNow(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function entity(overrides: Record<string, unknown>) {
  return {
    id: uid(),
    type: 'task',
    title: '',
    status: 'active',
    priority: 'medium',
    tags: [],
    metadata: {},
    ownerId: 'user-demo',
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function tracker(entityId: string, daysBack: number) {
  const d = new Date()
  d.setDate(d.getDate() - daysBack)
  return {
    id: uid(),
    entityId,
    value: 1,
    unit: 'done',
    timestamp: d.toISOString(),
    ownerId: 'user-demo',
  }
}

export function generateMockData() {
  const entities: ReturnType<typeof entity>[] = []
  const trackers: ReturnType<typeof tracker>[] = []

  // ── Goals ──
  const goalIds = {
    fitness: uid(),
    savings: uid(),
    project: uid(),
    reading: uid(),
  }
  entities.push(
    entity({ id: goalIds.fitness, type: 'goal', title: 'Run a half marathon', priority: 'high', tags: ['fitness'], metadata: { progress: 45 }, dueDate: daysFromNow(90) }),
    entity({ id: goalIds.savings, type: 'goal', title: 'Save 6-month emergency fund', priority: 'high', tags: ['finance'], metadata: { progress: 65 }, dueDate: daysFromNow(180) }),
    entity({ id: goalIds.project, type: 'goal', title: 'Launch side project', priority: 'urgent', tags: ['dev'], metadata: { progress: 30 }, dueDate: daysFromNow(60) }),
    entity({ id: goalIds.reading, type: 'goal', title: 'Read 24 books this year', priority: 'medium', tags: ['growth'], metadata: { progress: 25 } }),
  )

  // ── Stories (tasks with subtasks) ──
  const storyIds = { auth: uid(), deploy: uid(), weekend: uid() }
  entities.push(
    entity({
      id: storyIds.auth, type: 'task', title: 'Implement OAuth login', priority: 'high',
      tags: ['dev'], dueDate: today, metadata: {
        workspace: 'work',
        subtasks: [
          { id: uid(), title: 'Set up Google OAuth client', done: true },
          { id: uid(), title: 'Build callback handler', done: true },
          { id: uid(), title: 'Store tokens securely', done: false },
          { id: uid(), title: 'Add login button to UI', done: false },
          { id: uid(), title: 'Write integration tests', done: false },
        ],
      },
    }),
    entity({
      id: storyIds.deploy, type: 'task', title: 'Deploy to production', priority: 'urgent',
      tags: ['devops'], dueDate: daysFromNow(1), metadata: {
        workspace: 'work',
        subtasks: [
          { id: uid(), title: 'Run full test suite', done: false },
          { id: uid(), title: 'Build Docker image', done: false },
          { id: uid(), title: 'Update nginx config', done: false },
          { id: uid(), title: 'Deploy and smoke test', done: false },
        ],
      },
    }),
    entity({
      id: storyIds.weekend, type: 'task', title: 'Weekend trip planning', priority: 'medium',
      tags: ['travel'], dueDate: daysFromNow(3), metadata: {
        workspace: 'personal',
        subtasks: [
          { id: uid(), title: 'Book hotel', done: true },
          { id: uid(), title: 'Plan itinerary', done: false },
          { id: uid(), title: 'Pack bags', done: false },
        ],
      },
    }),
  )

  // ── Regular tasks ──
  const taskTitles = {
    work: [
      'Review PR #234', 'Update API documentation', 'Fix pagination bug',
      'Sprint retrospective meeting', 'Refactor user service', 'Database migration',
      'Code review for payment module', 'Set up monitoring alerts',
    ],
    personal: [
      'Grocery shopping', 'Pay electricity bill', 'Call dentist for appointment',
      'Renew gym membership', 'Clean apartment', 'Fix leaking faucet',
      'Research new phone plans', 'Organize photo library',
    ],
  }

  for (const title of taskTitles.work) {
    entities.push(entity({
      type: 'task', title, priority: pick(['high', 'medium', 'low']),
      tags: [pick(['dev', 'meeting', 'infra'])],
      dueDate: pick([today, daysFromNow(1), daysFromNow(3), daysFromNow(7)]),
      metadata: { workspace: 'work' },
    }))
  }

  for (const title of taskTitles.personal) {
    entities.push(entity({
      type: 'task', title, priority: pick(['medium', 'low']),
      dueDate: pick([today, daysFromNow(1), daysFromNow(5), undefined]),
      metadata: { workspace: 'personal' },
    }))
  }

  // Backlog tasks
  const backlogTitles = {
    work: ['Explore GraphQL migration', 'Document API endpoints', 'Refactor notification service'],
    personal: ['Learn Rust basics', 'Set up home NAS'],
  }
  for (const title of backlogTitles.work) {
    entities.push(entity({
      type: 'task', title, status: 'backlog', priority: pick(['medium', 'low']),
      metadata: { workspace: 'work', points: pick([2, 3, 5, 8]) },
    }))
  }
  for (const title of backlogTitles.personal) {
    entities.push(entity({
      type: 'task', title, status: 'backlog', priority: 'low',
      metadata: { workspace: 'personal', points: pick([3, 5]) },
    }))
  }

  // Completed tasks (for log view + standup)
  const doneTitles = [
    'Set up CI pipeline', 'Write unit tests for auth', 'Design landing page',
    'Fix CORS issue', 'Update dependencies', 'Optimize database queries',
    'Buy groceries', 'Book restaurant', 'Reply to emails',
  ]
  for (let i = 0; i < doneTitles.length; i++) {
    const d = new Date()
    d.setDate(d.getDate() - Math.floor(i / 3))
    entities.push(entity({
      type: 'task', title: doneTitles[i], status: 'completed',
      metadata: { workspace: i < 6 ? 'work' : 'personal' },
      updatedAt: d.toISOString(),
    }))
  }

  // ── Habits ──
  const habitIds: string[] = []
  const habitData = [
    { title: 'Morning exercise', streak: 12, frequency: 'daily' },
    { title: 'Read 30 minutes', streak: 8, frequency: 'daily' },
    { title: 'Meditate', streak: 5, frequency: 'daily' },
    { title: 'Drink 2L water', streak: 15, frequency: 'daily' },
    { title: 'No social media before noon', streak: 3, frequency: 'daily' },
  ]
  for (const h of habitData) {
    const id = uid()
    habitIds.push(id)
    entities.push(entity({
      id, type: 'habit', title: h.title, tags: ['health'],
      metadata: { streak: h.streak, frequency: h.frequency },
    }))
    // Generate trackers for streak
    for (let d = 0; d < h.streak; d++) {
      trackers.push(tracker(id, d))
    }
  }

  // ── Protocols ──
  const protocolIds: string[] = []
  const morningId = uid()
  const eveningId = uid()
  protocolIds.push(morningId, eveningId)

  entities.push(
    entity({
      id: morningId, type: 'habit', title: 'Morning Protocol',
      metadata: {
        streak: 7, frequency: 'daily', isProtocol: true,
        steps: [
          { id: uid(), label: 'Wake up by 6am', order: 0 },
          { id: uid(), label: 'Drink water (500ml)', order: 1 },
          { id: uid(), label: 'Meditate 10 min', order: 2 },
          { id: uid(), label: 'Exercise 30 min', order: 3 },
          { id: uid(), label: 'Cold shower', order: 4 },
          { id: uid(), label: 'Journal', order: 5 },
        ],
      },
    }),
    entity({
      id: eveningId, type: 'habit', title: 'Before Bed Protocol',
      metadata: {
        streak: 4, frequency: 'daily', isProtocol: true,
        steps: [
          { id: uid(), label: 'No screens 30 min before bed', order: 0 },
          { id: uid(), label: 'Prepare tomorrow\'s clothes', order: 1 },
          { id: uid(), label: 'Read 20 min', order: 2 },
          { id: uid(), label: 'Stretch / breathe', order: 3 },
          { id: uid(), label: 'Gratitude journal', order: 4 },
        ],
      },
    }),
  )
  for (const pid of protocolIds) {
    for (let d = 0; d < 5; d++) {
      trackers.push(tracker(pid, d))
    }
  }

  // ── Events ──
  entities.push(
    entity({ type: 'event', title: 'Sprint planning', dueDate: today, metadata: { time: '09:00' } }),
    entity({ type: 'event', title: 'Dentist appointment', dueDate: today, metadata: { time: '14:00' } }),
    entity({ type: 'event', title: 'Team dinner', dueDate: daysFromNow(2), metadata: { time: '18:30' } }),
    entity({ type: 'event', title: 'Code review meeting', dueDate: daysFromNow(1), metadata: { time: '10:00' } }),
  )

  // ── Notes ──
  entities.push(
    entity({ type: 'note', title: 'Architecture Decision: Event Sourcing', tags: ['dev', 'architecture'], metadata: { body: 'Decided to use event sourcing for the audit log module. Key benefits: full history, replay capability, natural fit for CQRS.', isJournal: false } }),
    entity({ type: 'note', title: 'Meeting Notes — Product Sync', tags: ['meeting'], metadata: { body: 'Discussed Q2 roadmap. Focus on mobile experience and API v2. Timeline: 6 weeks.', isJournal: false } }),
    entity({ type: 'note', title: 'Morning reflection', tags: ['journal'], metadata: { body: 'Feeling productive today. Made good progress on the OAuth implementation. Need to focus on tests tomorrow.', isJournal: true, date: today, mood: 'good' } }),
  )

  // ── Health: Body Metrics ──
  for (let i = 14; i >= 0; i--) {
    const weight = 72 + Math.random() * 2 - 1
    entities.push(entity({
      type: 'body-metric', title: `Weight — ${weight.toFixed(1)}`,
      metadata: { metricType: 'weight', value: Math.round(weight * 10) / 10, date: daysAgo(i) },
    }))
  }
  entities.push(
    entity({ type: 'body-metric', title: 'Body Fat — 18', metadata: { metricType: 'body-fat', value: 18, date: today } }),
  )

  // ── Health: Workouts ──
  const workoutTypes = ['strength', 'cardio', 'flexibility', 'hiit']
  const workoutNames = ['Upper body', 'Morning run', 'Yoga flow', 'HIIT circuit', 'Leg day', 'Swimming']
  for (let i = 0; i < 10; i++) {
    entities.push(entity({
      type: 'workout', title: pick(workoutNames),
      metadata: {
        workoutType: pick(workoutTypes),
        duration: pick([30, 45, 60]),
        calories: pick([200, 300, 400, 500]),
        date: daysAgo(i),
      },
    }))
  }

  // ── Health: Sleep & Mood ──
  for (let i = 0; i < 14; i++) {
    const hours = 6 + Math.random() * 2.5
    entities.push(entity({
      type: 'sleep-mood', title: `${hours.toFixed(1)}h sleep`,
      metadata: {
        sleepHours: Math.round(hours * 10) / 10,
        sleepQuality: pick(['deep', 'good', 'light']),
        mood: pick(['great', 'good', 'okay']),
        energy: Math.floor(Math.random() * 4) + 6,
        date: daysAgo(i),
      },
    }))
  }

  // ── Wealth ──
  entities.push(
    entity({ type: 'account', title: 'Checking Account', metadata: { balance: 45000, accountType: 'checking', currency: 'USD', institution: 'Chase' } }),
    entity({ type: 'account', title: 'Savings Account', metadata: { balance: 180000, accountType: 'savings', currency: 'USD', institution: 'Ally' } }),
    entity({ type: 'budget', title: 'Food Budget', tags: ['food'], metadata: { amount: 800, category: 'food', period: 'monthly', currency: 'USD' } }),
    entity({ type: 'budget', title: 'Transport Budget', tags: ['transport'], metadata: { amount: 200, category: 'transport', period: 'monthly', currency: 'USD' } }),
  )

  for (let i = 0; i < 8; i++) {
    entities.push(entity({
      type: 'transaction',
      title: pick(['Grocery', 'Gas', 'Restaurant', 'Coffee', 'Uber', 'Gym', 'Netflix', 'Electricity']),
      tags: [pick(['food', 'transport', 'entertainment', 'utilities'])],
      metadata: {
        amount: pick([15, 25, 45, 80, 120, 200]),
        txType: 'expense',
        category: pick(['food', 'transport', 'entertainment']),
        date: daysAgo(Math.floor(Math.random() * 14)),
        currency: 'USD',
      },
      dueDate: daysAgo(Math.floor(Math.random() * 14)),
    }))
  }
  entities.push(entity({
    type: 'transaction', title: 'Monthly salary', tags: ['income'],
    metadata: { amount: 8500, txType: 'income', category: 'salary', date: daysAgo(5), currency: 'USD' },
  }))

  // ── Books / Courses ──
  entities.push(
    entity({ type: 'book', title: 'Atomic Habits', tags: ['growth'], metadata: { author: 'James Clear', totalPages: 320, currentPage: 180, rating: 5 } }),
    entity({ type: 'book', title: 'Deep Work', tags: ['productivity'], status: 'completed', metadata: { author: 'Cal Newport', totalPages: 296, currentPage: 296, rating: 4 } }),
    entity({ type: 'course', title: 'Advanced TypeScript', tags: ['dev'], metadata: { totalPages: 50, currentPage: 35 } }),
  )

  // ── Chores ──
  entities.push(
    entity({ type: 'chore', title: 'Vacuum the house', tags: ['cleaning'], dueDate: daysFromNow(1), visibility: 'shared', metadata: { category: 'cleaning', frequency: 'weekly' } }),
    entity({ type: 'chore', title: 'Do laundry', tags: ['laundry'], dueDate: today, visibility: 'shared', metadata: { category: 'laundry', frequency: 'weekly' } }),
  )

  // ── Write to localStorage ──
  localStorage.setItem('life-os:entities', JSON.stringify(entities))
  localStorage.setItem('life-os:trackers', JSON.stringify(trackers))
  localStorage.setItem('life-os:schedules', JSON.stringify([]))
  localStorage.setItem('life-os:relations', JSON.stringify([]))

  // Health profile
  localStorage.setItem('life-os:health-profile', JSON.stringify({
    heightCm: 175,
    birthDate: '1995-06-15',
    gender: 'male',
    activityLevel: 'moderate',
  }))

  // Mock user
  localStorage.setItem('life-os:users', JSON.stringify([
    { id: 'user-demo', name: 'Demo User', role: 'admin', pin: 'demo' },
  ]))

  // Auto-login
  localStorage.setItem('life-os:auth', JSON.stringify({
    currentUser: { id: 'user-demo', name: 'Demo User', role: 'admin' },
    isAuthenticated: true,
  }))
}

export function clearMockData() {
  const keys = ['entities', 'trackers', 'schedules', 'relations', 'users', 'auth', 'health-profile']
  for (const key of keys) {
    localStorage.removeItem(`life-os:${key}`)
  }
}
