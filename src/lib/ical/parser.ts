import ICAL from 'ical.js'
import type { ICalEvent } from './types'

export function parseICalText(
  text: string,
  sourceUrl: string,
  sourceName: string,
): ICalEvent[] {
  const jcal = ICAL.parse(text)
  const comp = new ICAL.Component(jcal)
  const vevents = comp.getAllSubcomponents('vevent')

  // Filter to events within +/- 2 months of now
  const now = new Date()
  const rangeStart = new Date(now.getFullYear(), now.getMonth() - 2, 1)
  const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 3, 0)

  const events: ICalEvent[] = []

  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent)

    const start = event.startDate?.toJSDate()
    const end = event.endDate?.toJSDate()
    if (!start) continue

    // Skip events outside the range
    if (start > rangeEnd) continue
    if (end && end < rangeStart) continue
    if (!end && start < rangeStart) continue

    const isAllDay = event.startDate?.isDate ?? false

    events.push({
      id: event.uid || crypto.randomUUID(),
      title: event.summary || 'Untitled',
      description: event.description || undefined,
      start,
      end: end || start,
      location: event.location || undefined,
      isAllDay,
      source: 'ical',
      sourceUrl,
      sourceName,
    })
  }

  return events
}
