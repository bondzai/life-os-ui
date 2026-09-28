/**
 * The other systems Lyra speaks for, and the decisions they are waiting on.
 *
 * Mirrors `lyra_db::systems`. Two separate queries because they have different rhythms: the systems
 * list changes when you edit it, and the decisions list changes when a factory somewhere finishes
 * thinking. Polling the second one is the point of it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiSend } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'

export interface System {
  id: string
  name: string
  base_url: string
  /** Enough to tell two tokens apart, useless to anyone else. The real one never leaves the box. */
  token_preview: string | null
  stored_token: boolean
  scopes: string[]
  enabled: boolean
  cursor: string | null
  last_ok_at: number | null
  last_error: string | null
  failing_since: number | null
}

export interface DecisionOption {
  value: string
  label: string
}

export interface Decision {
  id: string
  system_id: string
  external_id: string
  question: string
  detail: string | null
  options: DecisionOption[]
  /** Why the system is asking. A decision without its evidence is a guess. */
  evidence: string | null
  raised_at: number
  expires_at: number | null
  answer: string | null
  answered_at: number | null
  /** When the origin confirmed it. Answered with no confirmation means still on its way. */
  delivered_at: number | null
  /** Decided server-side, against the clock that has to act on it. */
  expired: boolean
}

interface SystemsResponse {
  systems: System[]
  scopes: string[]
}

interface DecisionsResponse {
  decisions: Decision[]
  waiting: number
}

export function useSystems() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return useQuery<SystemsResponse>({
    queryKey: ['systems'],
    enabled: isAuthenticated,
    queryFn: () => apiGet<SystemsResponse>('systems'),
  })
}

export function useCreateSystem() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      name: string
      base_url: string
      token?: string
      scopes?: string[]
    }) => apiSend<System>('POST', 'systems', body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['systems'] }),
  })
}

/** `token` absent means "leave the stored one alone" — the screen was never given it. */
export type SystemPatch = Partial<Pick<System, 'name' | 'base_url' | 'scopes' | 'enabled'>> & {
  token?: string
}

export function useUpdateSystem() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & SystemPatch) =>
      apiSend<System>('PATCH', `systems/${encodeURIComponent(id)}`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['systems'] }),
  })
}

export function useDeleteSystem() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiSend<unknown>('DELETE', `systems/${encodeURIComponent(id)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['systems'] }),
  })
}

/** Ask a system whether it is there. The answer is written to the row as well as returned. */
export function useProbeSystem() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiSend<{ ok: boolean; error?: string }>(
        'POST',
        `systems/${encodeURIComponent(id)}/probe`,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: ['systems'] }),
  })
}

/**
 * The inbox.
 *
 * Refetched on a timer because the answer to "what needs me" arrives from somewhere else — a page
 * that only updates when you reload is a page that tells you there is nothing waiting when there is.
 * A minute is well under the half-minute-plus-notification path, so the tab is never the slow one.
 */
export function useDecisions() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return useQuery<DecisionsResponse>({
    queryKey: ['decisions'],
    enabled: isAuthenticated,
    refetchInterval: 60_000,
    queryFn: () => apiGet<DecisionsResponse>('decisions'),
  })
}

export function useAnswerDecision() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, answer }: { id: string; answer: string }) =>
      apiSend<Decision>('POST', `decisions/${encodeURIComponent(id)}/answer`, { answer }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['decisions'] }),
  })
}
