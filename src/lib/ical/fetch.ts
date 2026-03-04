const CORS_PROXIES = [
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.io/?url=',
]

/**
 * Convert Google Calendar web URLs to iCal feed URLs.
 * Accepts formats like:
 *   https://calendar.google.com/calendar/u/1?cid=BASE64_ENCODED_ID
 *   https://calendar.google.com/calendar?cid=BASE64_ENCODED_ID
 * And converts to:
 *   https://calendar.google.com/calendar/ical/DECODED_ID/public/basic.ics
 */
export function normalizeGCalUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'calendar.google.com' && parsed.searchParams.has('cid')) {
      const cid = parsed.searchParams.get('cid')!
      // cid is base64-encoded calendar ID — decode it
      let calendarId: string
      try {
        calendarId = atob(cid)
      } catch {
        // If not base64, use as-is (already a raw calendar ID)
        calendarId = cid
      }
      return `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`
    }
  } catch {
    // Not a valid URL, return as-is
  }
  return url
}

export async function fetchICalText(url: string): Promise<string> {
  const normalizedUrl = normalizeGCalUrl(url)

  // Try direct fetch first (works when same-origin or CORS-allowed, e.g. on the home server)
  try {
    const directRes = await fetch(normalizedUrl, { signal: AbortSignal.timeout(8000) })
    if (directRes.ok) {
      const text = await directRes.text()
      if (text.includes('BEGIN:VCALENDAR')) return text
    }
  } catch {
    // CORS blocked or network error — try proxies
  }

  // Try CORS proxies as fallback
  for (const proxy of CORS_PROXIES) {
    try {
      const fetchUrl = `${proxy}${encodeURIComponent(normalizedUrl)}`
      const response = await fetch(fetchUrl, { signal: AbortSignal.timeout(10000) })
      if (response.ok) {
        const text = await response.text()
        if (text.includes('BEGIN:VCALENDAR')) return text
      }
    } catch {
      continue
    }
  }

  throw new Error(`Failed to fetch iCal feed from ${normalizedUrl} — all proxies failed`)
}
