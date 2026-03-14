import { Hono } from 'hono'

const gcalRoutes = new Hono()

/**
 * GET /api/gcal/:calendarId/color
 *
 * Extracts the calendar color from Google Calendar's embed page.
 * No API key needed — parses the public embed HTML.
 */
gcalRoutes.get('/:calendarId/color', async (c) => {
  const calendarId = c.req.param('calendarId')

  try {
    const embedUrl = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calendarId)}`
    const res = await fetch(embedUrl, {
      headers: { 'User-Agent': 'Life-OS/1.0' },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      return c.json({ color: null, error: 'Failed to fetch embed page' }, 502)
    }

    const html = await res.text()

    // Google's embed page includes the calendar color in multiple places:
    // 1. In a <style> block: .view-cap { background-color: #039BE5 }
    // 2. In JS config: ['setCalendarColor','#039BE5']
    // 3. As data attribute or inline style

    // Try JS config pattern first (most reliable)
    const jsMatch = html.match(/setCalendarColor['"]\s*,\s*['"]([#][0-9a-fA-F]{6})['"]/i)
    if (jsMatch) {
      return c.json({ color: jsMatch[1] })
    }

    // Try background-color in calendar-specific styles
    const bgMatch = html.match(/background(?:-color)?\s*:\s*([#][0-9a-fA-F]{6})/i)
    if (bgMatch) {
      return c.json({ color: bgMatch[1] })
    }

    // Try data-calendarcolor or similar attributes
    const dataMatch = html.match(/data-calendar(?:c|C)olor\s*=\s*['"]([#][0-9a-fA-F]{6})['"]/i)
    if (dataMatch) {
      return c.json({ color: dataMatch[1] })
    }

    // Try extracting from the calendar chip color in the sidebar
    const chipMatch = html.match(/calendar-id-chip[^}]*?background-color:\s*([#][0-9a-fA-F]{6})/i)
    if (chipMatch) {
      return c.json({ color: chipMatch[1] })
    }

    return c.json({ color: null })
  } catch (err) {
    return c.json({ color: null, error: 'Request failed' }, 502)
  }
})

/**
 * GET /api/gcal/:calendarId/events
 *
 * Fetches events from a public Google Calendar via the iCal feed,
 * proxied through the server to avoid CORS issues.
 * Returns the raw iCal text for client-side parsing.
 */
gcalRoutes.get('/:calendarId/ical', async (c) => {
  const calendarId = c.req.param('calendarId')

  try {
    const icalUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`
    const res = await fetch(icalUrl, {
      signal: AbortSignal.timeout(15000),
    })

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
