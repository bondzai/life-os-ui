import type { ICalEvent } from './types'

function toDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function groupEventsByDate(events: ICalEvent[]): Record<string, ICalEvent[]> {
  const map: Record<string, ICalEvent[]> = {}

  for (const event of events) {
    if (event.isAllDay && event.end > event.start) {
      // Multi-day: add to each date
      const cursor = new Date(event.start)
      while (cursor < event.end) {
        const key = toDateKey(cursor)
        if (!map[key]) map[key] = []
        map[key].push(event)
        cursor.setDate(cursor.getDate() + 1)
      }
    } else {
      const key = toDateKey(event.start)
      if (!map[key]) map[key] = []
      map[key].push(event)
    }
  }

  return map
}
