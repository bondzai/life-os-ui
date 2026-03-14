import { API_URL } from '@/lib/api-url'
import type { ICalEvent } from './types'

const GCAL_API_KEY = import.meta.env.VITE_GCAL_API_KEY || ''

/** Google Calendar event color palette (colorId → hex) */
const EVENT_COLORS: Record<string, string> = {
  '1': '#7986cb',  // Lavender
  '2': '#33b679',  // Sage
  '3': '#8e24aa',  // Grape
  '4': '#e67c73',  // Flamingo
  '5': '#f6bf26',  // Banana
  '6': '#f4511e',  // Tangerine
  '7': '#039be5',  // Peacock
  '8': '#616161',  // Graphite
  '9': '#3f51b5',  // Blueberry
  '10': '#0b8043', // Basil
  '11': '#d50000', // Tomato
}

export function hasGCalApiKey(): boolean {
  return GCAL_API_KEY.length > 0
}

/**
 * Extract Google Calendar ID from various URL formats:
 * - https://calendar.google.com/calendar/ical/CALENDAR_ID/public/basic.ics
 * - https://calendar.google.com/calendar/embed?src=CALENDAR_ID
 * - https://calendar.google.com/calendar/u/1?cid=BASE64_ENCODED
 * - Raw calendar ID (email-like string)
 */
export function extractCalendarId(url: string): string | null {
  // Already a calendar ID (contains @ but no /)
  if (url.includes('@') && !url.includes('/')) {
    return url
  }

  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'calendar.google.com') return null

    // /ical/CALENDAR_ID/...
    const icalMatch = parsed.pathname.match(/\/ical\/([^/]+)\//)
    if (icalMatch) return decodeURIComponent(icalMatch[1])

    // ?src=CALENDAR_ID or ?cid=BASE64
    const src = parsed.searchParams.get('src')
    if (src) return src

    const cid = parsed.searchParams.get('cid')
    if (cid) {
      try {
        return atob(cid)
      } catch {
        return cid
      }
    }
  } catch {
    // Not a valid URL
  }

  return null
}

/**
 * Fetch calendar color via the Life-OS API proxy.
 * No Google API key needed — the server extracts color from Google's embed page.
 */
export async function fetchCalendarColor(calendarId: string): Promise<string | null> {
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
 * Fetch iCal text via the API server proxy (avoids CORS issues).
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

/** Fetch events from Google Calendar API v3 (requires VITE_GCAL_API_KEY) */
export async function fetchGCalEvents(
  calendarId: string,
  feedUrl: string,
  feedName: string,
): Promise<ICalEvent[]> {
  if (!GCAL_API_KEY) return []

  const now = new Date()
  const timeMin = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString()
  const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString()

  const params = new URLSearchParams({
    key: GCAL_API_KEY,
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '500',
    fields: 'items(id,summary,description,location,start,end,colorId)',
  })

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { signal: AbortSignal.timeout(15000) },
  )

  if (!res.ok) {
    throw new Error(`Google Calendar API error: ${res.status}`)
  }

  const data = await res.json()
  const items: unknown[] = data.items ?? []

  return items.map((item: unknown) => {
    const e = item as Record<string, unknown>
    const startObj = e.start as Record<string, string> | undefined
    const endObj = e.end as Record<string, string> | undefined
    const isAllDay = !!(startObj?.date)
    const start = new Date(startObj?.dateTime ?? startObj?.date ?? '')
    const end = new Date(endObj?.dateTime ?? endObj?.date ?? '')
    const colorId = e.colorId as string | undefined

    return {
      id: (e.id as string) || crypto.randomUUID(),
      title: (e.summary as string) || 'Untitled',
      description: (e.description as string) || undefined,
      start,
      end: isNaN(end.getTime()) ? start : end,
      location: (e.location as string) || undefined,
      isAllDay,
      source: 'ical' as const,
      sourceUrl: feedUrl,
      sourceName: feedName,
      color: colorId ? EVENT_COLORS[colorId] : undefined,
    }
  })
}
