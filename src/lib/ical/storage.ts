import type { ICalFeed } from './types'

const STORAGE_KEY = 'lyra:ical-feeds'

export function getFeeds(): ICalFeed[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveFeeds(feeds: ICalFeed[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(feeds))
}

export function addFeed(feed: ICalFeed): ICalFeed[] {
  const feeds = getFeeds()
  feeds.push(feed)
  saveFeeds(feeds)
  return feeds
}

export function removeFeed(id: string): ICalFeed[] {
  const feeds = getFeeds().filter((f) => f.id !== id)
  saveFeeds(feeds)
  return feeds
}

export function toggleFeed(id: string): ICalFeed[] {
  const feeds = getFeeds().map((f) =>
    f.id === id ? { ...f, enabled: !f.enabled } : f,
  )
  saveFeeds(feeds)
  return feeds
}
