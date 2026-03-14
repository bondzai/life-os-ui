import { Hono } from 'hono'

const gcalRoutes = new Hono()

const GCAL_API_BASE = 'https://www.googleapis.com/calendar/v3'

function getApiKey(): string {
  return process.env.GCAL_API_KEY || ''
}

/** Google Calendar color palette */
const CALENDAR_COLORS: Record<string, string> = {
  '1': '#ac725e', '2': '#d06b64', '3': '#f83a22', '4': '#fa573c',
  '5': '#ff7537', '6': '#ffad46', '7': '#42d692', '8': '#16a765',
  '9': '#7bd148', '10': '#b3dc6c', '11': '#fbe983', '12': '#fad165',
  '13': '#92e1c0', '14': '#9fe1e7', '15': '#9fc6e7', '16': '#4986e7',
  '17': '#9a9cff', '18': '#b99aff', '19': '#c2c2c2', '20': '#cabdbf',
  '21': '#cca6ac', '22': '#f691b2', '23': '#cd74e6', '24': '#a47ae2',
}

const EVENT_COLORS: Record<string, string> = {
  '1': '#7986cb', '2': '#33b679', '3': '#8e24aa', '4': '#e67c73',
  '5': '#f6bf26', '6': '#f4511e', '7': '#039be5', '8': '#616161',
  '9': '#3f51b5', '10': '#0b8043', '11': '#d50000',
}

/**
 * GET /api/gcal/:calendarId/color
 * Fetches calendar color from Google Calendar API (server-side, no CORS).
 */
gcalRoutes.get('/:calendarId/color', async (c) => {
  const calendarId = c.req.param('calendarId')
  const apiKey = getApiKey()

  if (!apiKey) {
    return c.json({ color: null, error: 'GCAL_API_KEY not configured' })
  }

  try {
    const res = await fetch(
      `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}?key=${apiKey}&fields=backgroundColor,colorId`,
      { signal: AbortSignal.timeout(8000) },
    )

    if (!res.ok) {
      const text = await res.text()
      return c.json({ color: null, error: `Google API ${res.status}: ${text}` }, 502)
    }

    const data = await res.json() as { backgroundColor?: string; colorId?: string }
    const color = data.backgroundColor || (data.colorId ? CALENDAR_COLORS[data.colorId] : null)
    return c.json({ color })
  } catch (err) {
    return c.json({ color: null, error: 'Request failed' }, 502)
  }
})

/**
 * GET /api/gcal/:calendarId/events
 * Fetches events with per-event colors from Google Calendar API.
 */
gcalRoutes.get('/:calendarId/events', async (c) => {
  const calendarId = c.req.param('calendarId')
  const apiKey = getApiKey()

  if (!apiKey) {
    return c.json({ items: [], error: 'GCAL_API_KEY not configured' })
  }

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
      maxResults: '500',
    })

    const res = await fetch(
      `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { signal: AbortSignal.timeout(15000) },
    )

    if (!res.ok) {
      return c.json({ items: [], error: `Google API ${res.status}` }, 502)
    }

    const data = await res.json() as { items?: Array<Record<string, unknown>> }
    const items = (data.items ?? []).map((item) => ({
      id: item.id,
      summary: item.summary,
      description: item.description,
      location: item.location,
      start: item.start,
      end: item.end,
      colorId: item.colorId,
      color: item.colorId ? EVENT_COLORS[item.colorId as string] : undefined,
    }))

    return c.json({ items })
  } catch {
    return c.json({ items: [], error: 'Request failed' }, 502)
  }
})

/**
 * GET /api/gcal/:calendarId/ical
 * Proxies iCal feed (no CORS issues).
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
