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
    status: 'todo',
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

  // ── Stories (tasks with subtasks, linked to goals) ──
  const storyIds = { auth: uid(), deploy: uid(), weekend: uid(), training: uid(), budget: uid() }
  entities.push(
    entity({
      id: storyIds.auth, type: 'task', title: 'Implement OAuth login', priority: 'high',
      tags: ['dev'], dueDate: today, metadata: {
        workspace: 'work', goalId: goalIds.project,
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
        workspace: 'work', goalId: goalIds.project,
        subtasks: [
          { id: uid(), title: 'Run full test suite', done: false },
          { id: uid(), title: 'Build Docker image', done: false },
          { id: uid(), title: 'Update nginx config', done: false },
          { id: uid(), title: 'Deploy and smoke test', done: false },
        ],
      },
    }),
    entity({
      id: storyIds.training, type: 'task', title: 'Build 8-week running plan', priority: 'high',
      tags: ['fitness'], dueDate: daysFromNow(7), metadata: {
        workspace: 'personal', goalId: goalIds.fitness,
        subtasks: [
          { id: uid(), title: 'Research beginner plans', done: true },
          { id: uid(), title: 'Set weekly mileage targets', done: true },
          { id: uid(), title: 'Buy running shoes', done: false },
          { id: uid(), title: 'Schedule first 5K race', done: false },
        ],
      },
    }),
    entity({
      id: storyIds.budget, type: 'task', title: 'Set up auto-transfer to savings', priority: 'medium',
      tags: ['finance'], dueDate: daysFromNow(3), metadata: {
        workspace: 'personal', goalId: goalIds.savings,
        subtasks: [
          { id: uid(), title: 'Compare savings accounts', done: true },
          { id: uid(), title: 'Configure auto-transfer', done: false },
          { id: uid(), title: 'Set up alerts at milestones', done: false },
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

  const workGoalMap: Record<string, string | undefined> = {
    'Review PR #234': goalIds.project,
    'Update API documentation': goalIds.project,
    'Fix pagination bug': goalIds.project,
    'Refactor user service': goalIds.project,
  }
  for (const title of taskTitles.work) {
    entities.push(entity({
      type: 'task', title, priority: pick(['high', 'medium', 'low']),
      tags: [pick(['dev', 'meeting', 'infra'])],
      dueDate: pick([today, daysFromNow(1), daysFromNow(3), daysFromNow(7)]),
      metadata: { workspace: 'work', ...(workGoalMap[title] ? { goalId: workGoalMap[title] } : {}) },
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
      type: 'task', title: doneTitles[i], status: 'done',
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

  // ── Notes (rich set for Note Map / Knowledge Graph) ──
  const noteIds = {
    eventSourcing: uid(),
    cqrs: uid(),
    productSync: uid(),
    apiDesign: uid(),
    systemDesign: uid(),
    dockerBestPractices: uid(),
    ciCd: uid(),
    techDebt: uid(),
    secondBrain: uid(),
    zettelkasten: uid(),
    deepWorkNote: uid(),
    stoicism: uid(),
    weeklyReflection: uid(),
    morningReflection: uid(),
    investingBasics: uid(),
    compoundInterest: uid(),
  }

  entities.push(
    // Dev / Architecture cluster
    entity({ id: noteIds.eventSourcing, type: 'note', title: 'Architecture Decision: Event Sourcing', tags: ['dev', 'architecture', 'backend'], metadata: { body: 'Decided to use event sourcing for the audit log module. Key benefits: full history, replay capability, natural fit for CQRS. Trade-offs: increased storage, eventual consistency complexity.' } }),
    entity({ id: noteIds.cqrs, type: 'note', title: 'CQRS Pattern Deep Dive', tags: ['dev', 'architecture', 'patterns'], metadata: { body: 'Command Query Responsibility Segregation separates read and write models. Works well with event sourcing. Consider for high-read/low-write scenarios.' } }),
    entity({ id: noteIds.apiDesign, type: 'note', title: 'API Design Principles', tags: ['dev', 'backend', 'api'], metadata: { body: 'REST best practices: use nouns for resources, proper HTTP verbs, pagination via cursor, versioning in URL path. Consider GraphQL for complex queries.' } }),
    entity({ id: noteIds.systemDesign, type: 'note', title: 'System Design Interview Notes', tags: ['dev', 'architecture', 'career'], metadata: { body: 'Key areas: load balancing, caching (Redis), database sharding, message queues, CDN. Always start with requirements and back-of-envelope calculations.' } }),
    entity({ id: noteIds.dockerBestPractices, type: 'note', title: 'Docker Best Practices', tags: ['dev', 'devops', 'infra'], metadata: { body: 'Multi-stage builds, .dockerignore, non-root user, health checks, layer caching optimization. Pin base image versions for reproducibility.' } }),
    entity({ id: noteIds.ciCd, type: 'note', title: 'CI/CD Pipeline Design', tags: ['dev', 'devops', 'infra'], metadata: { body: 'Stages: lint → test → build → deploy. Use matrix builds for multi-platform. Cache dependencies aggressively. Blue-green deployment for zero-downtime.' } }),
    entity({ id: noteIds.techDebt, type: 'note', title: 'Tech Debt Quadrant', tags: ['dev', 'architecture', 'strategy'], metadata: { body: 'Martin Fowler\'s quadrant: Reckless/Deliberate × Prudent/Inadvertent. Track tech debt as tickets. Allocate 20% sprint capacity for paydown. Document decisions in ADRs.' } }),

    // Meeting / Work
    entity({ id: noteIds.productSync, type: 'note', title: 'Meeting Notes — Product Sync', tags: ['meeting', 'strategy'], metadata: { body: 'Discussed Q2 roadmap. Focus on mobile experience and API v2. Timeline: 6 weeks. Key decision: defer analytics dashboard to Q3.' } }),

    // Knowledge / Learning cluster
    entity({ id: noteIds.secondBrain, type: 'note', title: 'Building a Second Brain (PARA)', tags: ['productivity', 'knowledge', 'strategy'], metadata: { body: 'Tiago Forte\'s PARA: Projects, Areas, Resources, Archives. Capture → Organize → Distill → Express. Progressive summarization for notes.', isPinned: true } }),
    entity({ id: noteIds.zettelkasten, type: 'note', title: 'Zettelkasten Method', tags: ['productivity', 'knowledge', 'writing'], metadata: { body: 'Atomic notes, unique IDs, bidirectional links. Each note = one idea. Connection-first thinking. Luhmann\'s slip box produced 70 books and 400 papers.' } }),
    entity({ id: noteIds.deepWorkNote, type: 'note', title: 'Deep Work — Key Takeaways', tags: ['productivity', 'career', 'books'], metadata: { body: 'Cal Newport: Deep work is rare and valuable. Rules: Work deeply, embrace boredom, quit social media, drain the shallows. Schedule every minute of your day.' } }),

    // Philosophy / Growth
    entity({ id: noteIds.stoicism, type: 'note', title: 'Stoic Principles for Daily Life', tags: ['philosophy', 'growth', 'strategy'], metadata: { body: 'Dichotomy of control, memento mori, amor fati, negative visualization. Marcus Aurelius: "You have power over your mind, not outside events."' } }),

    // Finance cluster
    entity({ id: noteIds.investingBasics, type: 'note', title: 'Investing 101 — Index Funds', tags: ['finance', 'strategy', 'learning'], metadata: { body: 'Low-cost index funds outperform 90% of active managers over 15 years. Dollar-cost averaging removes timing risk. Start with total market + international.' } }),
    entity({ id: noteIds.compoundInterest, type: 'note', title: 'The Power of Compound Interest', tags: ['finance', 'growth'], metadata: { body: 'Rule of 72: divide 72 by annual return to get doubling time. 7% return → doubles in ~10 years. Start early, stay consistent, reinvest dividends.' } }),

    // Journals
    entity({ id: noteIds.morningReflection, type: 'note', title: 'Morning reflection', tags: ['journal'], metadata: { body: 'Feeling productive today. Made good progress on the OAuth implementation. Need to focus on tests tomorrow.', isJournal: true, date: today, mood: 'good' } }),
    entity({ id: noteIds.weeklyReflection, type: 'note', title: 'Weekly Review — Week 12', tags: ['journal', 'strategy'], metadata: { body: 'Good week overall. Shipped auth feature, maintained exercise streak. Need to improve sleep schedule. Next week: focus on deployment pipeline.', isJournal: true, date: daysAgo(2), mood: 'calm' } }),
  )

  // ── Relations (for Note Map knowledge graph) ──
  const relations = [
    // Architecture cluster connections
    { id: uid(), fromId: noteIds.eventSourcing, toId: noteIds.cqrs, type: 'relates' },
    { id: uid(), fromId: noteIds.cqrs, toId: noteIds.apiDesign, type: 'relates' },
    { id: uid(), fromId: noteIds.systemDesign, toId: noteIds.eventSourcing, type: 'supports' },
    { id: uid(), fromId: noteIds.systemDesign, toId: noteIds.apiDesign, type: 'supports' },
    { id: uid(), fromId: noteIds.techDebt, toId: noteIds.cqrs, type: 'relates' },

    // DevOps cluster
    { id: uid(), fromId: noteIds.dockerBestPractices, toId: noteIds.ciCd, type: 'relates' },
    { id: uid(), fromId: noteIds.ciCd, toId: noteIds.techDebt, type: 'supports' },

    // Knowledge / Productivity cluster
    { id: uid(), fromId: noteIds.secondBrain, toId: noteIds.zettelkasten, type: 'relates' },
    { id: uid(), fromId: noteIds.deepWorkNote, toId: noteIds.secondBrain, type: 'supports' },
    { id: uid(), fromId: noteIds.zettelkasten, toId: noteIds.deepWorkNote, type: 'relates' },

    // Cross-cluster connections
    { id: uid(), fromId: noteIds.stoicism, toId: noteIds.deepWorkNote, type: 'supports' },
    { id: uid(), fromId: noteIds.productSync, toId: noteIds.techDebt, type: 'relates' },
    { id: uid(), fromId: noteIds.investingBasics, toId: noteIds.compoundInterest, type: 'relates' },
    { id: uid(), fromId: noteIds.stoicism, toId: noteIds.secondBrain, type: 'supports' },
  ]

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
    entity({ type: 'book', title: 'Deep Work', tags: ['productivity'], status: 'done', metadata: { author: 'Cal Newport', totalPages: 296, currentPage: 296, rating: 4 } }),
    entity({ type: 'course', title: 'Advanced TypeScript', tags: ['dev'], metadata: { totalPages: 50, currentPage: 35 } }),
  )

  // ── Chores ──
  entities.push(
    entity({ type: 'chore', title: 'Vacuum the house', tags: ['cleaning'], dueDate: daysFromNow(1), visibility: 'shared', metadata: { category: 'cleaning', frequency: 'weekly' } }),
    entity({ type: 'chore', title: 'Do laundry', tags: ['laundry'], dueDate: today, visibility: 'shared', metadata: { category: 'laundry', frequency: 'weekly' } }),
  )

  // ── Write to localStorage ──
  localStorage.setItem('lyra:entities', JSON.stringify(entities))
  localStorage.setItem('lyra:trackers', JSON.stringify(trackers))
  localStorage.setItem('lyra:schedules', JSON.stringify([]))
  localStorage.setItem('lyra:relations', JSON.stringify(relations))

  // Health profile
  localStorage.setItem('lyra:health-profile', JSON.stringify({
    heightCm: 175,
    birthDate: '1995-06-15',
    gender: 'male',
    activityLevel: 'moderate',
  }))

  // Mock user
  localStorage.setItem('lyra:users', JSON.stringify([
    { id: 'user-demo', name: 'Demo User', role: 'admin', pin: 'demo' },
  ]))

  // Auto-login
  localStorage.setItem('lyra:auth', JSON.stringify({
    currentUser: { id: 'user-demo', name: 'Demo User', role: 'admin' },
    isAuthenticated: true,
  }))
}

export function clearMockData() {
  const keys = ['entities', 'trackers', 'schedules', 'relations', 'users', 'auth', 'health-profile']
  for (const key of keys) {
    localStorage.removeItem(`lyra:${key}`)
  }
}
