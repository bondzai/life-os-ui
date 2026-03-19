import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import {
  type ICalFeed,
  type ICalEvent,
  getFeeds,
  saveFeeds,
  addFeed,
  removeFeed,
  toggleFeed,
  fetchICalText,
  parseICalText,
} from '@/lib/ical'
import {
  extractCalendarId,
  fetchGCalEventsDirect,
  fetchGCalEventsViaProxy,
  fetchICalViaProxy,
  fetchCalendarColor,
} from '@/lib/ical/gcal-api'

const QUERY_KEY = ['ical-events']

/**
 * If events from Google Calendar API carry a calendar color that differs
 * from the stored feed color, update the feed so the chip/dot match.
 */
function syncFeedColor(feed: ICalFeed, events: ICalEvent[]): void {
  // Find a consistent calendar color from the events (events without per-event colorId
  // get the calendar's backgroundColor — that's the one we want)
  const calColor = events[0]?.color
  if (calColor && calColor !== feed.color) {
    const feeds = getFeeds()
    const idx = feeds.findIndex((f) => f.id === feed.id)
    if (idx !== -1) {
      feeds[idx] = { ...feeds[idx], color: calColor }
      saveFeeds(feeds)
    }
  }
}

async function fetchFeedEvents(feed: ICalFeed): Promise<ICalEvent[]> {
  const calendarId = extractCalendarId(feed.url)

  if (calendarId) {
    // 1. Try direct Google Calendar API from browser (uses public embed key, gets per-event colors)
    try {
      const events = await fetchGCalEventsDirect(calendarId, feed.url, feed.name)
      if (events && events.length > 0) {
        syncFeedColor(feed, events)
        return events
      }
    } catch {
      // Fall back
    }

    // 2. Try Google Calendar API via server proxy
    try {
      const events = await fetchGCalEventsViaProxy(calendarId, feed.url, feed.name)
      if (events && events.length > 0) {
        syncFeedColor(feed, events)
        return events
      }
    } catch {
      // Fall back
    }

    // 3. Try iCal via server proxy (no CORS issues, but no colors)
    try {
      const text = await fetchICalViaProxy(calendarId)
      if (text) return parseICalText(text, feed.url, feed.name)
    } catch {
      // Fall back
    }
  }

  // 4. Default: fetch via iCal (direct + external CORS proxies, no colors)
  const text = await fetchICalText(feed.url)
  return parseICalText(text, feed.url, feed.name)
}

async function fetchAllFeeds(): Promise<{ feeds: ICalFeed[]; events: ICalEvent[] }> {
  const feeds = getFeeds()
  const enabledFeeds = feeds.filter((f) => f.enabled)

  const results = await Promise.allSettled(
    enabledFeeds.map((feed) => fetchFeedEvents(feed)),
  )

  const events: ICalEvent[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      events.push(...result.value)
    }
  }

  return { feeds, events }
}

export function useICalEvents() {
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchAllFeeds,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  })

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    [queryClient],
  )

  const add = useCallback(
    async (feed: ICalFeed) => {
      // Auto-detect Google Calendar color
      const calendarId = extractCalendarId(feed.url)
      if (calendarId) {
        const color = await fetchCalendarColor(calendarId)
        if (color) feed = { ...feed, color }
      }
      addFeed(feed)
      invalidate()
    },
    [invalidate],
  )

  const remove = useCallback(
    (id: string) => {
      removeFeed(id)
      invalidate()
    },
    [invalidate],
  )

  const toggle = useCallback(
    (id: string) => {
      toggleFeed(id)
      invalidate()
    },
    [invalidate],
  )

  return {
    feeds: data?.feeds ?? getFeeds(),
    events: data?.events ?? [],
    isLoading,
    error,
    add,
    remove,
    toggle,
  }
}
