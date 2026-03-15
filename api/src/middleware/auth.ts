import { Hono } from 'hono'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required')
  process.exit(1)
}

// Simple in-memory rate limiter for login attempts
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000 // 15 minutes

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

export const authRoutes = new Hono()

// POST /api/auth/login
authRoutes.post('/login', async (c) => {
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown'
  if (!checkRateLimit(ip)) {
    return c.json({ error: 'Too many login attempts. Try again later.' }, 429)
  }

  const body = await c.req.json<{ pin: string }>()
  const { pin } = body

  if (!pin) {
    return c.json({ error: 'PIN is required' }, 400)
  }

  const allUsers = db.select().from(users).all()
  const user = allUsers.find((u) => u.pin && bcrypt.compareSync(pin, u.pin))

  if (!user) {
    return c.json({ error: 'Invalid PIN' }, 401)
  }

  const token = jwt.sign(
    { userId: user.id, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  )

  return c.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, avatarUrl: user.avatarUrl },
  })
})

// JWT middleware
export function jwtMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    const authHeader = c.req.header('Authorization')

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const token = authHeader.slice(7)

    try {
      const payload = jwt.verify(token, JWT_SECRET) as { userId: string; role: string }
      c.set('userId', payload.userId)
      c.set('userRole', payload.role)
      await next()
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }
  }
}
