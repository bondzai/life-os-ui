import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import {
  type ICalFeed,
  type ICalEvent,
  getFeeds,
  addFeed,
  removeFeed,
  toggleFeed,
  fetchICalText,
  parseICalText,
} from '@/lib/ical'
import {
  hasGCalApiKey,
  extractCalendarId,
  fetchGCalEvents,
  fetchCalendarColor,
  fetchICalViaProxy,
} from '@/lib/ical/gcal-api'

const QUERY_KEY = ['ical-events']

async function fetchFeedEvents(feed: ICalFeed): Promise<ICalEvent[]> {
  const calendarId = extractCalendarId(feed.url)

  // If Google API key is configured, use it for per-event colors
  if (hasGCalApiKey() && calendarId) {
    try {
      return await fetchGCalEvents(calendarId, feed.url, feed.name)
    } catch {
      // Fall back to other methods
    }
  }

  // For Google Calendars: try API server proxy (no CORS issues, no external proxies)
  if (calendarId) {
    try {
      const text = await fetchICalViaProxy(calendarId)
      if (text) return parseICalText(text, feed.url, feed.name)
    } catch {
      // Fall back to direct/CORS proxy fetch
    }
  }

  // Default: fetch via iCal (direct + external CORS proxies)
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
      // Auto-detect Google Calendar color via server proxy (no API key needed)
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
