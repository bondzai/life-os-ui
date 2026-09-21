/**
 * The queue's depth and its most recent rows.
 *
 * A count, not a stream — and that is the whole design note. Agent state is a handful of in-memory
 * records that change on an event, so it is pushed. A queue depth is a `COUNT` over a table, and
 * pushing it down every socket on every event turns one query into one query per listener per job.
 * So this polls, slowly, and the socket next to it carries the part that has to feel instant.
 */

import { useQuery } from '@tanstack/react-query'
import { API_URL } from '@/lib/api-url'
import { useAuthStore } from '@/stores/auth-store'

export interface QueuedJob {
  id: string
  kind: string
  lane: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  attempts: number
  max_attempts: number
  updated_at: number
  last_error: string | null
}

export interface Queue {
  counts: { queued: number; running: number; failed: number }
  /** How long the oldest *runnable* job has waited. `null` when nothing is waiting. */
  oldest_queued_secs: number | null
  recent: QueuedJob[]
}

/** Slow on purpose: this is context for the live part beside it, not the live part. */
const REFETCH_MS = 5_000

export function useQueue() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  return useQuery<Queue>({
    queryKey: ['jobs'],
    enabled: isAuthenticated,
    refetchInterval: REFETCH_MS,
    queryFn: async () => {
      const token = localStorage.getItem('lyra:token')
      const res = await fetch(`${API_URL}/jobs`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(`the queue could not be read (${res.status})`)
      return res.json()
    },
  })
}
