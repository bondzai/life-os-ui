import { API_URL } from '@/lib/api-url'
import type { ICalEvent } from './types'

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

    const icalMatch = parsed.pathname.match(/\/ical\/([^/]+)\//)
    if (icalMatch) return decodeURIComponent(icalMatch[1])

    const src = parsed.searchParams.get('src')
    if (src) return src

    const cid = parsed.searchParams.get('cid')
    if (cid) {
      try { return atob(cid) } catch { return cid }
    }
  } catch {
    // Not a valid URL
  }

  return null
}

/**
 * Fetch calendar color via the Life-OS API server.
 * Server calls Google Calendar API with its own API key.
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
 * Fetch events with per-event colors via the API server.
 * Server calls Google Calendar API — returns events with hex colors.
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

    return data.items.map((item: Record<string, unknown>) => {
      const startObj = item.start as Record<string, string> | undefined
      const endObj = item.end as Record<string, string> | undefined
      const isAllDay = !!(startObj?.date)
      const start = new Date(startObj?.dateTime ?? startObj?.date ?? '')
      const end = new Date(endObj?.dateTime ?? endObj?.date ?? '')

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
        color: (item.color as string) || undefined,
      }
    })
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
