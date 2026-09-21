/**
 * The queue's depth and its most recent rows.
 *
 * A count, not a stream — and that is the whole design note. Agent state is a handful of in-memory
 * records that change on an event, so it is pushed. A queue depth is a `COUNT` over a table, and
 * pushing it down every socket on every event turns one query into one query per listener per job.
 * So this polls, slowly, and the socket next to it carries the part that has to feel instant.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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

/**
 * Retry or cancel one job.
 *
 * Both refresh the list on success rather than editing it in place: the server decides what a
 * retry produced (a new row, or the one a double click already made), and guessing would show a
 * row that does not exist for five seconds.
 */
export function useJobAction() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'retry' | 'cancel' }) => {
      const token = localStorage.getItem('lyra:token')
      const res = await fetch(`${API_URL}/jobs/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        // The server says *which* state made it impossible — "this one is running" — which is
        // the only thing worth showing. A bare status code would tell the reader nothing.
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `could not ${action} (${res.status})`)
      }
      return res.json()
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['jobs'] }),
  })
}
