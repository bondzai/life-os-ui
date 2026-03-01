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

const QUERY_KEY = ['ical-events']

async function fetchAllFeeds(): Promise<{ feeds: ICalFeed[]; events: ICalEvent[] }> {
  const feeds = getFeeds()
  const enabledFeeds = feeds.filter((f) => f.enabled)

  const results = await Promise.allSettled(
    enabledFeeds.map(async (feed) => {
      const text = await fetchICalText(feed.url)
      return parseICalText(text, feed.url, feed.name)
    }),
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
    (feed: ICalFeed) => {
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
