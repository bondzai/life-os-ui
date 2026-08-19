/**
 * Snowball membership and its climb history.
 *
 * Both live in `localStorage` rather than on the server, because a snowball is an opinion about
 * one's own holdings, not a fact the backend knows: the API has no notion of which pool the user
 * considers their engine, and inventing an endpoint for it would put a schema around a scratchpad.
 *
 * Tags are read through an external store so the ❄ toggle on DeFi and the panel on Overview stay
 * in step within a session — two `useState` copies of the same key would drift apart until a
 * reload.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  sbMonthly,
  sbWeekDelta,
  snowballMembers,
  type Ctx,
  type SbMember,
  type SbTags,
} from './derive'
import type { NwPoint } from './types'

const TAGS_KEY = 'lyra:wealth:snowball'
const HISTORY_KEY = 'lyra:wealth:snowball-history'

/** Half a year of daily points: enough for the chart, small enough to keep in a string. */
const MAX_POINTS = 180

function readTags(): SbTags {
  try {
    const raw = localStorage.getItem(TAGS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Only truthy entries survive: an id written as `false` by an older build is not a member.
    const tags: SbTags = {}
    for (const [id, on] of Object.entries(parsed as Record<string, unknown>)) {
      if (on) tags[id] = true
    }
    return tags
  } catch {
    return {}
  }
}

/** Server render has no `localStorage`; an empty basket is the honest answer there. */
const EMPTY_TAGS: SbTags = {}

/**
 * One parsed copy of the tags, shared by every subscriber.
 *
 * `getSnapshot` must return the same object until something actually changes, or `useSyncExternal-
 * Store` re-renders forever — so the parsed value is cached against the raw string it came from.
 * Re-reading that string on every snapshot is cheap and means a write from anywhere (another tab,
 * a test clearing storage) is picked up without an invalidation protocol.
 */
const store = {
  raw: null as string | null,
  tags: EMPTY_TAGS as SbTags,
  listeners: new Set<() => void>(),
  subscribe(onChange: () => void): () => void {
    store.listeners.add(onChange)
    return () => store.listeners.delete(onChange)
  },
  getSnapshot(): SbTags {
    const raw = localStorage.getItem(TAGS_KEY)
    if (raw !== store.raw) {
      store.raw = raw
      store.tags = readTags()
    }
    return store.tags
  },
  set(tags: SbTags): void {
    localStorage.setItem(TAGS_KEY, JSON.stringify(tags))
    store.raw = null // force a re-parse, so the snapshot is exactly what was stored
    for (const listener of store.listeners) listener()
  },
}

export interface SnowballTags {
  tags: SbTags
  isTagged: (id: string) => boolean
  toggle: (id: string) => void
}

export function useSnowballTags(): SnowballTags {
  const tags = useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_TAGS)

  const toggle = useCallback((id: string) => {
    const next = { ...store.getSnapshot() }
    // Untagging deletes the key rather than storing `false`, so the file stays a membership list.
    if (next[id]) delete next[id]
    else next[id] = true
    store.set(next)
  }, [])

  const isTagged = useCallback((id: string) => tags[id] === true, [tags])

  return { tags, isTagged, toggle }
}

function readHistory(raw: string | null): NwPoint[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is NwPoint =>
        Boolean(p) && typeof p === 'object' && typeof (p as NwPoint).d === 'number' && typeof (p as NwPoint).v === 'number',
    )
  } catch {
    return []
  }
}

/** Midnight local time — the bucket a value is filed under. */
function dayKey(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const EMPTY_HISTORY: NwPoint[] = []

/**
 * The climb series, kept in `localStorage` and read the same way the tags are.
 *
 * An external store rather than component state: recording a point is a write to something
 * outside React, and modelling it as `useState` + an effect means every recorded point costs a
 * second render pass.
 */
const historyStore = {
  raw: null as string | null,
  points: EMPTY_HISTORY as NwPoint[],
  listeners: new Set<() => void>(),
  subscribe(onChange: () => void): () => void {
    historyStore.listeners.add(onChange)
    return () => historyStore.listeners.delete(onChange)
  },
  getSnapshot(): NwPoint[] {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw !== historyStore.raw) {
      historyStore.raw = raw
      historyStore.points = readHistory(raw)
    }
    return historyStore.points
  },
  /**
   * File today's basket value, last write wins.
   *
   * One point per day, not per render: the snowball is a story about weeks, and an intraday
   * series would just redraw the market's noise on top of it. A same-day rewrite of the same
   * value is a no-op, so an idle screen never notifies.
   */
  record(value: number, now = Date.now()): void {
    const history = [...historyStore.getSnapshot()]
    const today = dayKey(now)
    const last = history[history.length - 1]
    if (last && last.d === today) {
      if (last.v === value) return
      history[history.length - 1] = { ...last, v: value }
    } else {
      history.push({ d: today, v: value })
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_POINTS)))
    historyStore.raw = null // force a re-parse, so the snapshot is exactly what was stored
    for (const listener of historyStore.listeners) listener()
  },
}

export interface SnowballState {
  members: SbMember[]
  total: number
  /** The bitcoin-denominated part of the basket, in USD. */
  btcUsd: number
  history: NwPoint[]
  /** Change over the last seven days, or `null` while the series is too short to say. */
  weekDelta: number | null
  /** Implied USD/month from the realized slope, or `null` under three days of history. */
  monthly: number | null
}

/**
 * The basket as it stands, plus its own climb series.
 *
 * The series is separate from net-worth history on purpose: net worth moves with the whole book,
 * while the point of the snowball is to watch one deliberately chosen slice of it grow.
 */
export function useSnowball(ctx: Ctx | null): SnowballState {
  const { tags } = useSnowballTags()

  const members = useMemo(() => (ctx ? snowballMembers(ctx, tags) : []), [ctx, tags])
  const total = useMemo(() => members.reduce((sum, m) => sum + m.usd, 0), [members])
  const btcUsd = useMemo(() => members.reduce((sum, m) => sum + m.btcUsd, 0), [members])

  const history = useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getSnapshot,
    () => EMPTY_HISTORY,
  )

  useEffect(() => {
    // Nothing tagged is not a basket worth zero — recording it would draw a crash on the chart
    // the day someone clears their tags.
    if (!members.length) return
    historyStore.record(total)
  }, [members.length, total])

  return {
    members,
    total,
    btcUsd,
    history,
    weekDelta: sbWeekDelta(history),
    monthly: sbMonthly(history),
  }
}
