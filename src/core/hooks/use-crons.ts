/**
 * Schedules you can change without a reinstall.
 *
 * Mirrors `lyra_db::crons`. The schedule is a tagged union rather than a cron string, so the form can
 * render it without a parser — and a mis-typed cron expression fails by a message silently never
 * arriving, which is the one failure this cannot have.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiSend } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import type { Severity } from '@/core/hooks/use-channels'

export type Schedule =
  | { kind: 'daily'; at_minute: number }
  | { kind: 'weekly'; days: number[]; at_minute: number }
  | { kind: 'every'; seconds: number }

export interface Cron {
  id: string
  name: string
  schedule: Schedule
  /** In words, rendered server-side so the two cannot disagree about "every 15 minutes". */
  describes: string
  action: string
  payload: { text?: string; group?: string; severity?: Severity }
  enabled: boolean
  /** How late a firing may be and still happen. */
  catch_up_minutes: number
  last_occurrence: string | null
  last_fired_at: number | null
  /** Slots that went by unfired. Shown, because a schedule that silently stops is the point. */
  missed: number
  last_missed_at: number | null
}

interface CronsResponse {
  crons: Cron[]
  actions: string[]
  groups: string[]
}

export function useCrons() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return useQuery<CronsResponse>({
    queryKey: ['crons'],
    enabled: isAuthenticated,
    queryFn: () => apiGet<CronsResponse>('crons'),
  })
}

export function useCreateCron() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      name: string
      schedule: Schedule
      action: string
      payload: Record<string, unknown>
      catch_up_minutes?: number
    }) => apiSend<Cron>('POST', 'crons', body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['crons'] }),
  })
}

/**
 * Only the five fields the server honours.
 *
 * Not `Partial<Cron>`: `action` and the counters are not editable, and a type that let you send them
 * would read as though they were, then silently drop them on the floor.
 */
export type CronPatch = Partial<
  Pick<Cron, 'name' | 'schedule' | 'payload' | 'enabled' | 'catch_up_minutes'>
>

export function useUpdateCron() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & CronPatch) =>
      apiSend<Cron>('PATCH', `crons/${encodeURIComponent(id)}`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['crons'] }),
  })
}

export function useDeleteCron() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiSend<unknown>('DELETE', `crons/${encodeURIComponent(id)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['crons'] }),
  })
}

/**
 * Run one now, without waiting for its time.
 *
 * It does not consume the day's occurrence, so the scheduled firing still happens — which is what
 * makes this safe to press while testing.
 */
export function useRunCron() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiSend<unknown>('POST', `crons/${encodeURIComponent(id)}/run`),
    onSettled: () => client.invalidateQueries({ queryKey: ['crons'] }),
  })
}

/** `07:30` from minutes past midnight, and back. The form speaks clock time; the API speaks minutes. */
export function toClock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function fromClock(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}
