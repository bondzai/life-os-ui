import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoutes, jwtMiddleware } from './middleware/auth.js'
import { entityRoutes } from './routes/entities.js'
import { trackerRoutes } from './routes/trackers.js'
import { scheduleRoutes } from './routes/schedules.js'
import { relationRoutes } from './routes/relations.js'
import { gcalRoutes } from './routes/gcal.js'
import { sqlite } from './db/index.js'

const app = new Hono()

// CORS
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:8080']

app.use(
  '/*',
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]),
    credentials: true,
  }),
)

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// Auth routes (no JWT required)
app.route('/api/auth', authRoutes)

// JWT-protected routes
app.use('/api/entities/*', jwtMiddleware())
app.use('/api/trackers/*', jwtMiddleware())
app.use('/api/schedules/*', jwtMiddleware())
app.use('/api/relations/*', jwtMiddleware())

// Google Calendar OAuth — protect auth/* (except callback) and events/*
app.use('/api/gcal/auth/url', jwtMiddleware())
app.use('/api/gcal/auth/status', jwtMiddleware())
app.use('/api/gcal/auth/disconnect', jwtMiddleware())
app.use('/api/gcal/events', jwtMiddleware())
app.use('/api/gcal/events/*', jwtMiddleware())

app.route('/api/entities', entityRoutes)
app.route('/api/trackers', trackerRoutes)
app.route('/api/schedules', scheduleRoutes)
app.route('/api/relations', relationRoutes)
app.route('/api/gcal', gcalRoutes)

const port = Number(process.env.PORT) || 3001

serve({ fetch: app.fetch, port }, () => {
  console.log(`Lyra API running on http://localhost:${port}`)
})

// Graceful shutdown
process.on('SIGINT', () => {
  sqlite.close()
  process.exit(0)
})
