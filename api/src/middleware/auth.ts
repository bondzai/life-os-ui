import { Hono } from 'hono'
import jwt from 'jsonwebtoken'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const JWT_SECRET = process.env.JWT_SECRET || 'life-os-secret'

export const authRoutes = new Hono()

// POST /api/auth/login
authRoutes.post('/login', async (c) => {
  const body = await c.req.json<{ pin: string }>()
  const { pin } = body

  if (!pin) {
    return c.json({ error: 'PIN is required' }, 400)
  }

  const allUsers = db.select().from(users).all()
  const user = allUsers.find((u) => u.pin === pin)

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
