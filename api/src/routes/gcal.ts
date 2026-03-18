import crypto from 'crypto'
import { Hono } from 'hono'
import { db } from '../db/index.js'
import { googleTokens } from '../db/schema.js'
import { eq } from 'drizzle-orm'

type Env = { Variables: { userId: string; userRole: string } }

const gcalRoutes = new Hono<Env>()

// Secure OAuth state management — prevents CSRF
const oauthStates = new Map<string, { userId: string; expiresAt: number }>()
const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

function createOAuthState(userId: string): string {
  const state = crypto.randomBytes(32).toString('hex')
  oauthStates.set(state, { userId, expiresAt: Date.now() + STATE_TTL_MS })
  // Cleanup expired
  for (const [key, val] of oauthStates) {
    if (val.expiresAt < Date.now()) oauthStates.delete(key)
  }
  return state
}

function validateOAuthState(state: string): string | null {
  const entry = oauthStates.get(state)
  if (!entry || entry.expiresAt < Date.now()) {
    oauthStates.delete(state)
    return null
  }
  oauthStates.delete(state) // One-time use
  return entry.userId
}

/**
 * Google Calendar's own embed widget uses this public API key.
 * It works for any PUBLIC calendar without user configuration.
 * Falls back to user-provided GCAL_API_KEY if set.
 */
const EMBED_PUBLIC_KEY = 'AIzaSyBNlYH01_9Hc5S1J9vuFmu2nUqBZJNAXxs'
const GCAL_API_BASE = 'https://www.googleapis.com/calendar/v3'
const GOOGLE_OAUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

function getApiKey(): string {
  return process.env.GCAL_API_KEY || EMBED_PUBLIC_KEY
}

/** Google Calendar event color palette (colorId → hex) */
const EVENT_COLORS: Record<string, string> = {
  '1': '#7986cb', '2': '#33b679', '3': '#8e24aa', '4': '#e67c73',
  '5': '#f6bf26', '6': '#f4511e', '7': '#039be5', '8': '#616161',
  '9': '#3f51b5', '10': '#0b8043', '11': '#d50000',
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

interface StoredToken {
  userId: string
  accessToken: string | null
  refreshToken: string | null
  expiresAt: string | null
  calendarId: string | null
}

async function getValidAccessToken(userId: string): Promise<{ accessToken: string; calendarId: string | null } | null> {
  const rows = await db.select().from(googleTokens).where(eq(googleTokens.userId, userId))
  const row = rows[0] as StoredToken | undefined
  if (!row?.accessToken || !row?.refreshToken) return null

  const now = Date.now()
  const expiresAt = row.expiresAt ? new Date(row.expiresAt).getTime() : 0

  // Token still valid (with 60s buffer)
  if (expiresAt > now + 60_000) {
    return { accessToken: row.accessToken, calendarId: row.calendarId }
  }

  // Refresh the token
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: row.refreshToken,
        grant_type: 'refresh_token',
      }),
    })

    if (!res.ok) return null

    const data = await res.json() as { access_token: string; expires_in: number }
    const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

    await db.update(googleTokens)
      .set({ accessToken: data.access_token, expiresAt: newExpiresAt })
      .where(eq(googleTokens.userId, userId))

    return { accessToken: data.access_token, calendarId: row.calendarId }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// OAuth routes — mounted at /api/gcal/auth/*
// ---------------------------------------------------------------------------

/**
 * GET /api/gcal/auth/url
 * Returns Google OAuth consent URL.
 */
gcalRoutes.get('/auth/url', (c) => {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
  if (!clientId || !redirectUri) {
    return c.json({ error: 'Google OAuth not configured' }, 500)
  }

  const userId = c.get('userId') as string
  const state = createOAuthState(userId)
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  return c.json({ url: `${GOOGLE_OAUTH_BASE}?${params}` })
})

/**
 * GET /api/gcal/auth/callback?code=...&state=userId
 * Exchanges auth code for tokens, stores in DB, redirects to app.
 * This route is NOT JWT-protected (it's a redirect from Google).
 */
gcalRoutes.get('/auth/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const errorParam = c.req.query('error')

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'

  if (errorParam || !code || !state) {
    return c.redirect(`${frontendUrl}/calendar?google=error`)
  }

  const userId = validateOAuthState(state)
  if (!userId) {
    return c.redirect(`${frontendUrl}/calendar?google=error`)
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    return c.redirect(`${frontendUrl}/calendar?google=error`)
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenRes.ok) {
      return c.redirect(`${frontendUrl}/calendar?google=error`)
    }

    const tokenData = await tokenRes.json() as {
      access_token: string
      refresh_token?: string
      expires_in: number
    }

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString()

    // Fetch primary calendar ID
    let calendarId: string | null = null
    try {
      const calRes = await fetch(`${GCAL_API_BASE}/calendars/primary`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (calRes.ok) {
        const calData = await calRes.json() as { id?: string }
        calendarId = calData.id || null
      }
    } catch {
      // Not critical — calendarId will be null
    }

    // Upsert tokens
    const existing = await db.select().from(googleTokens).where(eq(googleTokens.userId, userId))
    if (existing.length > 0) {
      await db.update(googleTokens)
        .set({
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || existing[0].refreshToken,
          expiresAt,
          calendarId,
        })
        .where(eq(googleTokens.userId, userId))
    } else {
      await db.insert(googleTokens)
        .values({
          userId,
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || null,
          expiresAt,
          calendarId,
        })
    }

    return c.redirect(`${frontendUrl}/calendar?google=connected`)
  } catch {
    return c.redirect(`${frontendUrl}/calendar?google=error`)
  }
})

/**
 * GET /api/gcal/auth/status
 * Returns whether current user has Google tokens stored.
 */
gcalRoutes.get('/auth/status', async (c) => {
  const userId = c.get('userId') as string
  const rows = await db.select().from(googleTokens).where(eq(googleTokens.userId, userId))
  const connected = rows.length > 0 && !!rows[0].refreshToken
  return c.json({ connected, calendarId: rows[0]?.calendarId || null })
})

/**
 * DELETE /api/gcal/auth/disconnect
 * Removes stored tokens for current user.
 */
gcalRoutes.delete('/auth/disconnect', async (c) => {
  const userId = c.get('userId') as string
  await db.delete(googleTokens).where(eq(googleTokens.userId, userId))
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// CRUD routes for Google Calendar events (OAuth)
// ---------------------------------------------------------------------------

/**
 * POST /api/gcal/events
 * Create an event on Google Calendar.
 */
gcalRoutes.post('/events', async (c) => {
  const userId = c.get('userId') as string
  const token = await getValidAccessToken(userId)
  if (!token) return c.json({ error: 'Google Calendar not connected' }, 401)

  const body = await c.req.json()
  const calendarId = body.calendarId || token.calendarId || 'primary'

  const eventBody: Record<string, unknown> = {
    summary: body.summary,
    description: body.description,
    location: body.location,
    start: body.start,
    end: body.end,
  }
  if (body.colorId) eventBody.colorId = body.colorId

  try {
    const res = await fetch(
      `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventBody),
        signal: AbortSignal.timeout(15000),
      },
    )

    if (!res.ok) {
      const text = await res.text()
      return c.json({ error: `Google API ${res.status}: ${text.slice(0, 200)}` }, 502)
    }

    const data = await res.json()
    return c.json(data, 201)
  } catch {
    return c.json({ error: 'Failed to create event' }, 502)
  }
})

/**
 * PATCH /api/gcal/events/:eventId
 * Update an event on Google Calendar.
 */
gcalRoutes.patch('/events/:eventId', async (c) => {
  const userId = c.get('userId') as string
  const eventId = c.req.param('eventId')
  const token = await getValidAccessToken(userId)
  if (!token) return c.json({ error: 'Google Calendar not connected' }, 401)

  const body = await c.req.json()
  const calendarId = body.calendarId || token.calendarId || 'primary'

  // Only include fields that were provided
  const eventBody: Record<string, unknown> = {}
  if (body.summary !== undefined) eventBody.summary = body.summary
  if (body.description !== undefined) eventBody.description = body.description
  if (body.location !== undefined) eventBody.location = body.location
  if (body.start !== undefined) eventBody.start = body.start
  if (body.end !== undefined) eventBody.end = body.end
  if (body.colorId !== undefined) eventBody.colorId = body.colorId

  try {
    const res = await fetch(
      `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventBody),
        signal: AbortSignal.timeout(15000),
      },
    )

    if (!res.ok) {
      const text = await res.text()
      return c.json({ error: `Google API ${res.status}: ${text.slice(0, 200)}` }, 502)
    }

    const data = await res.json()
    return c.json(data)
  } catch {
    return c.json({ error: 'Failed to update event' }, 502)
  }
})

/**
 * DELETE /api/gcal/events/:eventId
 * Delete an event from Google Calendar.
 */
gcalRoutes.delete('/events/:eventId', async (c) => {
  const userId = c.get('userId') as string
  const eventId = c.req.param('eventId')
  const token = await getValidAccessToken(userId)
  if (!token) return c.json({ error: 'Google Calendar not connected' }, 401)

  const calendarId = c.req.query('calendarId') || token.calendarId || 'primary'

  try {
    const res = await fetch(
      `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token.accessToken}` },
        signal: AbortSignal.timeout(15000),
      },
    )

    if (!res.ok && res.status !== 410) {
      const text = await res.text()
      return c.json({ error: `Google API ${res.status}: ${text.slice(0, 200)}` }, 502)
    }

    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'Failed to delete event' }, 502)
  }
})

// ---------------------------------------------------------------------------
// Public proxy routes (no auth needed) — using public embed key
// ---------------------------------------------------------------------------

/**
 * GET /api/gcal/:calendarId/events
 * Fetches events with per-event colors from Google Calendar API.
 * Uses Google's public embed key — no user API key required for public calendars.
 */
gcalRoutes.get('/:calendarId/events', async (c) => {
  const calendarId = c.req.param('calendarId')
  const apiKey = getApiKey()

  const now = new Date()
  const timeMin = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString()
  const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString()

  try {
    const params = new URLSearchParams({
      key: apiKey,
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      sanitizeHtml: 'true',
      calendarId,
    })

    const res = await fetch(
      `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      {
        signal: AbortSignal.timeout(15000),
        headers: {
          'Referer': 'https://calendar.google.com',
        },
      },
    )

    if (!res.ok) {
      const text = await res.text()
      return c.json({ items: [], error: `Google API ${res.status}: ${text.slice(0, 200)}` }, 502)
    }

    const data = await res.json() as {
      items?: Array<Record<string, unknown>>
      summary?: string
      backgroundColor?: string
    }

    // Calendar-level color (from the calendar metadata in the response)
    const calendarColor = data.backgroundColor || null

    const items = (data.items ?? []).map((item) => {
      // Per-event color: use colorId lookup, or fall back to calendar color
      const colorId = item.colorId as string | undefined
      const eventColor = colorId ? EVENT_COLORS[colorId] : undefined

      return {
        id: item.id,
        summary: item.summary,
        description: item.description,
        location: item.location,
        start: item.start,
        end: item.end,
        colorId,
        color: eventColor || calendarColor,
      }
    })

    return c.json({ items, calendarColor })
  } catch (err) {
    return c.json({ items: [], error: 'Request failed' }, 502)
  }
})

/**
 * GET /api/gcal/:calendarId/color
 * Fetches calendar-level color.
 */
gcalRoutes.get('/:calendarId/color', async (c) => {
  const calendarId = c.req.param('calendarId')
  const apiKey = getApiKey()

  try {
    const res = await fetch(
      `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}?key=${apiKey}&fields=backgroundColor,colorId,summary`,
      {
        signal: AbortSignal.timeout(8000),
        headers: { 'Referer': 'https://calendar.google.com' },
      },
    )

    if (!res.ok) {
      return c.json({ color: null, error: `Google API ${res.status}` }, 502)
    }

    const data = await res.json() as { backgroundColor?: string; colorId?: string }
    const color = data.backgroundColor || (data.colorId ? EVENT_COLORS[data.colorId] : null)
    return c.json({ color })
  } catch {
    return c.json({ color: null, error: 'Request failed' }, 502)
  }
})

/**
 * GET /api/gcal/:calendarId/ical
 * Proxies iCal feed server-side (no CORS issues).
 */
gcalRoutes.get('/:calendarId/ical', async (c) => {
  const calendarId = c.req.param('calendarId')

  try {
    const icalUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`
    const res = await fetch(icalUrl, { signal: AbortSignal.timeout(15000) })

    if (!res.ok) {
      return c.text('Failed to fetch calendar', 502)
    }

    const text = await res.text()
    return c.text(text, 200, { 'Content-Type': 'text/calendar' })
  } catch {
    return c.text('Request failed', 502)
  }
})

export { gcalRoutes }
