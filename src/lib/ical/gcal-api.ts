import { API_URL } from '@/lib/api-url'
import type { ICalEvent } from './types'

/**
 * Google's own embed widget uses this public API key to fetch calendar data.
 * Works for any PUBLIC calendar — no user API key needed.
 */
const GCAL_PUBLIC_KEY = 'AIzaSyBNlYH01_9Hc5S1J9vuFmu2nUqBZJNAXxs'
const GCAL_API_BASE = 'https://www.googleapis.com/calendar/v3'

/** Google Calendar event color palette (colorId → hex) */
const EVENT_COLORS: Record<string, string> = {
  '1': '#7986cb', '2': '#33b679', '3': '#8e24aa', '4': '#e67c73',
  '5': '#f6bf26', '6': '#f4511e', '7': '#039be5', '8': '#616161',
  '9': '#3f51b5', '10': '#0b8043', '11': '#d50000',
}

/**
 * Try to decode a base64-encoded calendar ID.
 */
function tryDecodeBase64(value: string): string {
  if (value.includes('@')) return value
  try {
    const decoded = atob(value)
    if (decoded.includes('@')) return decoded
  } catch {
    // Not valid base64
  }
  return value
}

/**
 * Extract Google Calendar ID from various URL formats:
 * - https://calendar.google.com/calendar/ical/CALENDAR_ID/public/basic.ics
 * - https://calendar.google.com/calendar/embed?src=CALENDAR_ID (may be base64)
 * - https://calendar.google.com/calendar/u/1?cid=BASE64_ENCODED
 * - Raw calendar ID (email-like string)
 */
export function extractCalendarId(url: string): string | null {
  if (url.includes('@') && !url.includes('/')) {
    return url
  }

  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'calendar.google.com') return null

    const icalMatch = parsed.pathname.match(/\/ical\/([^/]+)\//)
    if (icalMatch) return decodeURIComponent(icalMatch[1])

    const src = parsed.searchParams.get('src')
    if (src) return tryDecodeBase64(src)

    const cid = parsed.searchParams.get('cid')
    if (cid) return tryDecodeBase64(cid)
  } catch {
    // Not a valid URL
  }

  return null
}

/**
 * Default Google Calendar blue — used when neither event nor calendar has a color.
 */
const GCAL_DEFAULT_BLUE = '#039BE5'

/**
 * Parse Google Calendar API v3 event items into ICalEvent[].
 * Every event is guaranteed to have a color:
 *   1. Event's own colorId → hex from EVENT_COLORS
 *   2. Calendar's backgroundColor (from /calendars/:id)
 *   3. Default Google Calendar blue (#039BE5)
 */
function parseGCalItems(
  items: Array<Record<string, unknown>>,
  feedUrl: string,
  feedName: string,
  calendarColor?: string,
): ICalEvent[] {
  const defaultColor = calendarColor || GCAL_DEFAULT_BLUE

  return items.map((item) => {
    const startObj = item.start as Record<string, string> | undefined
    const endObj = item.end as Record<string, string> | undefined
    const isAllDay = !!(startObj?.date)
    const start = new Date(startObj?.dateTime ?? startObj?.date ?? '')
    const end = new Date(endObj?.dateTime ?? endObj?.date ?? '')
    const colorId = item.colorId as string | undefined
    // Per-event color takes priority, then calendar color, then default blue
    const color = (colorId ? EVENT_COLORS[colorId] : null) || defaultColor

    return {
      id: (item.id as string) || crypto.randomUUID(),
      title: (item.summary as string) || 'Untitled',
      description: (item.description as string) || undefined,
      start,
      end: isNaN(end.getTime()) ? start : end,
      location: (item.location as string) || undefined,
      isAllDay,
      source: 'ical' as const,
      sourceUrl: feedUrl,
      sourceName: feedName,
      color,
    }
  })
}

/**
 * Fetch events directly from Google Calendar API v3 using the public embed key.
 * Works from browser — Google Calendar API supports CORS.
 * This is the same key Google's own embed widget uses.
 *
 * Fetches calendar metadata first to get the calendar's default color,
 * then fetches events. Events with their own colorId use that color;
 * events without colorId use the calendar's backgroundColor.
 * This ensures every event always has a color from Google.
 */
export async function fetchGCalEventsDirect(
  calendarId: string,
  feedUrl: string,
  feedName: string,
): Promise<ICalEvent[] | null> {
  try {
    // Fetch calendar default color and events in parallel
    const [calendarColor, eventsData] = await Promise.all([
      fetchCalendarColorDirect(calendarId),
      (async () => {
        const now = new Date()
        const timeMin = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString()
        const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString()

        const params = new URLSearchParams({
          key: GCAL_PUBLIC_KEY,
          timeMin,
          timeMax,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '2500',
        })

        const res = await fetch(
          `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
          { signal: AbortSignal.timeout(15000) },
        )

        if (!res.ok) return null
        return res.json() as Promise<{ items?: Array<Record<string, unknown>> }>
      })(),
    ])

    if (!eventsData?.items?.length) return null

    // calendarColor is the calendar's own default — every event gets this unless it has its own colorId
    return parseGCalItems(eventsData.items, feedUrl, feedName, calendarColor ?? undefined)
  } catch {
    return null
  }
}

/**
 * Fetch calendar color directly from Google Calendar API v3.
 */
export async function fetchCalendarColorDirect(calendarId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}?key=${GCAL_PUBLIC_KEY}&fields=backgroundColor`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (!res.ok) return null
    const data = await res.json() as { backgroundColor?: string }
    return data.backgroundColor || null
  } catch {
    return null
  }
}

/**
 * Fetch calendar color — tries direct API first, then server proxy.
 */
export async function fetchCalendarColor(calendarId: string): Promise<string | null> {
  // Try direct browser call first
  const directColor = await fetchCalendarColorDirect(calendarId)
  if (directColor) return directColor

  // Fall back to API server proxy
  try {
    const res = await fetch(
      `${API_URL}/gcal/${encodeURIComponent(calendarId)}/color`,
      { signal: AbortSignal.timeout(10000) },
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.color || null
  } catch {
    return null
  }
}

/**
 * Fetch events with per-event colors via the API server proxy.
 */
export async function fetchGCalEventsViaProxy(
  calendarId: string,
  feedUrl: string,
  feedName: string,
): Promise<ICalEvent[] | null> {
  try {
    const res = await fetch(
      `${API_URL}/gcal/${encodeURIComponent(calendarId)}/events`,
      { signal: AbortSignal.timeout(15000) },
    )
    if (!res.ok) return null
    const data = await res.json()

    if (data.error || !data.items?.length) return null

    const calendarColor = (data.calendarColor as string) || undefined
    return parseGCalItems(data.items, feedUrl, feedName, calendarColor)
  } catch {
    return null
  }
}

/**
 * Fetch iCal text via the API server proxy (avoids CORS).
 */
export async function fetchICalViaProxy(calendarId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${API_URL}/gcal/${encodeURIComponent(calendarId)}/ical`,
      { signal: AbortSignal.timeout(15000) },
    )
    if (!res.ok) return null
    const text = await res.text()
    return text.includes('BEGIN:VCALENDAR') ? text : null
  } catch {
    return null
  }
}
