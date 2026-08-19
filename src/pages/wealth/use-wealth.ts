/**
 * The single data hook behind every wealth surface.
 *
 * Every surface reads from here, so they can never disagree about the numbers: one fetch, one
 * cache entry, one `Ctx`. Which backend is behind it is the `WEALTH_SOURCE` assignment below —
 * nothing else in the feature knows which one it is talking to.
 */

import { useMemo, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth-store'
import { USE_API } from '@/core/repositories'
import { apiWealthRepository } from '@/core/repositories/api-wealth-repository'
import { mockWealthSource, type WealthDataSource } from './data-source'
import type { Ctx } from './derive'

/**
 * Live or mock, decided the same way the rest of the app decides it: the `lyra:data-mode` the
 * user picked at login, falling back to `VITE_USE_API`.
 *
 * Deliberately not a switch of its own. A session showing demo entities alongside real balances
 * would be indistinguishable from a session where the wealth API had quietly started lying.
 */
export const WEALTH_SOURCE: WealthDataSource = USE_API ? apiWealthRepository : mockWealthSource

/** Portfolio data is expensive to compute server-side; a minute of staleness is a fair trade. */
const STALE_MS = 60_000

/** Older than this and the UI says so rather than presenting stale money as current. */
export const STALE_WARN_SECONDS = 15 * 60

export interface WealthState {
  ctx: Ctx | null
  isLoading: boolean
  error: Error | null
  /** true while a background refetch runs over data already on screen */
  isRefreshing: boolean
  /** no wallets configured — the onboarding case, not an error */
  isEmpty: boolean
  /** seconds since the snapshot was taken, or null when unknown */
  ageSeconds: number | null
  isStale: boolean
  refetch: () => void
}

/**
 * A shared ticking clock, modelled as an external store.
 *
 * Reading `Date.now()` during render is impure, and it also means data only *becomes* stale when
 * something else happens to re-render — the warning would never appear on an idle screen. One
 * module-level interval drives every subscriber, and it stops when the last one unmounts.
 */
const clock = {
  now: Date.now(),
  listeners: new Set<() => void>(),
  timer: null as ReturnType<typeof setInterval> | null,
  subscribe(onChange: () => void): () => void {
    clock.now = Date.now() // a fresh read on mount; the module may have loaded long ago
    clock.listeners.add(onChange)
    clock.timer ??= setInterval(() => {
      clock.now = Date.now()
      for (const listener of clock.listeners) listener()
    }, 30_000)
    return () => {
      clock.listeners.delete(onChange)
      if (clock.listeners.size === 0 && clock.timer) {
        clearInterval(clock.timer)
        clock.timer = null
      }
    }
  },
  // Must be cached rather than a fresh `Date.now()`, or React re-renders forever.
  getSnapshot: (): number => clock.now,
}

function useNow(): number {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot)
}

export function useWealth(dustUsd = 0): WealthState {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const now = useNow()

  const portfolio = useQuery({
    queryKey: ['wealth', 'portfolio'],
    queryFn: () => WEALTH_SOURCE.getPortfolio(),
    enabled: isAuthenticated,
    staleTime: STALE_MS,
    retry: false,
  })

  const history = useQuery({
    queryKey: ['wealth', 'history'],
    queryFn: () => WEALTH_SOURCE.getHistory(),
    enabled: isAuthenticated,
    staleTime: STALE_MS,
    retry: false,
  })

  const manual = useQuery({
    queryKey: ['wealth', 'manual'],
    queryFn: () => WEALTH_SOURCE.getManualAssets(),
    enabled: isAuthenticated,
    staleTime: STALE_MS,
    retry: false,
  })

  const ctx = useMemo<Ctx | null>(() => {
    if (!portfolio.data) return null
    // Manual assets are additive; if only that call fails the on-chain total is still worth
    // showing, so it degrades to an empty list rather than blocking the whole page.
    return { data: portfolio.data, manual: manual.data ?? [], dustUsd }
  }, [portfolio.data, manual.data, dustUsd])

  const ageSeconds = ctx ? Math.max(0, now / 1000 - ctx.data.fetched_at) : null

  return {
    ctx,
    isLoading: portfolio.isLoading,
    // Only the portfolio query can fail the page — history drives one panel and degrades to empty.
    error: (portfolio.error as Error | null) ?? null,
    isRefreshing: portfolio.isFetching && !portfolio.isLoading,
    isEmpty: Boolean(portfolio.data && portfolio.data.wallets.length === 0 && (manual.data?.length ?? 0) === 0),
    ageSeconds,
    isStale: ageSeconds !== null && ageSeconds > STALE_WARN_SECONDS,
    refetch: () => {
      void portfolio.refetch()
      void history.refetch()
      void manual.refetch()
    },
  }
}

/** The net-worth history series, separate because it drives one panel and may legitimately be empty. */
export function useWealthHistory() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const query = useQuery({
    queryKey: ['wealth', 'history'],
    queryFn: () => WEALTH_SOURCE.getHistory(),
    enabled: isAuthenticated,
    staleTime: STALE_MS,
    retry: false,
  })
  return {
    points: query.data ?? [],
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  }
}
