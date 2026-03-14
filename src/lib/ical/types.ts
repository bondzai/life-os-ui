export interface ICalEvent {
  id: string
  title: string
  description?: string
  start: Date
  end: Date
  location?: string
  isAllDay: boolean
  source: 'ical'
  sourceUrl: string
  sourceName: string
  /** Per-event color from Google Calendar API (hex). Falls back to feed color if absent. */
  color?: string
}

export interface ICalFeed {
  id: string
  name: string
  url: string
  color: string
  enabled: boolean
  lastFetched?: string
}
